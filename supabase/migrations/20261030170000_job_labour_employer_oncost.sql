-- Job labour cost: group shares, the company's super and commission advances.
--
-- Owner, 30 Oct 2026: get the integrated system (Bookkeeping, Context, Job
-- Profit, Xero) live and reconciled. Job Profit read crew labour from trade
-- invoice lines and three things were wrong:
--   * a group work order share (line type 'group share') fell to 'other';
--   * the company's super on crew pay was on no job at all;
--   * a commission advance ("Commission Advance", typed labour) counted as
--     labour on the job it names.
-- Money rules (Job Profit INBOX 30 Oct): the group budget is expected cost;
-- actual cost is the share invoices plus the company's super, once. A worker's
-- own super withheld, ute hire and other payout deductions are not reductions
-- of job cost. Work dates are not approval: has_unapproved_trade still flags it.
--
-- Columns of both views are unchanged; consumers keep reading them as before.
-- Rollback: supabase/rollbacks/20261030170000_job_labour_employer_oncost_down.sql

CREATE OR REPLACE VIEW public.v_trade_charge_resolved AS
WITH line_base AS (
  SELECT
    til.id,
    til.trade_invoice_id,
    til.job_id,
    til.job_number,
    til.line_type,
    til.description,
    til.total_hours,
    til.hourly_rate,
    til.line_total_ex,
    til.line_date,
    til.division,
    til.flag_type,
    til.baseline_hours,
    til.baseline_source,
    til.hours_justification,
    til.flagged_at,
    NULLIF(BTRIM(til.job_number), '') AS line_job_number,
    NULLIF(
      substring(
        UPPER(COALESCE(til.description, ''))
        FROM '(SWMS-[0-9]+|SWG-[0-9]+|SWF-[0-9]+|SWP-[0-9]+|BWCWA[0-9]+|AJBR-[0-9]+|MLB-[0-9]+)'
      ),
      ''
    ) AS description_job_number,
    (
      COALESCE(til.description, '') ILIKE '%QA TEST%'
      OR COALESCE(til.description, '') ILIKE '%make-safe hours - delete%'
      OR COALESCE(til.description, '') ILIKE '%makesafe hours - delete%'
    ) AS is_probable_test_line
  FROM public.trade_invoice_lines til
)
SELECT
  lb.id AS line_id,
  COALESCE(j_direct.id, j_line.id, j_desc.id) AS resolved_job_id,
  (j_direct.id IS NOT NULL) AS attributed_direct,
  ti.id AS trade_invoice_id,
  ti.user_id,
  ti.week_start,
  ti.status AS invoice_status,
  ti.xero_bill_id,
  lb.line_type,
  lb.description,
  lb.total_hours,
  lb.hourly_rate,
  lb.line_total_ex,
  lb.line_date,
  lb.division,
  CASE
    -- A commission advance is paid ahead of an earning. It is not a cost of
    -- the job it names until the commission is earned.
    WHEN lb.line_type IN ('labour', 'commission')
      AND COALESCE(lb.description, '') ~* '\mcommission\s+advance\M' THEN 'advance'
    WHEN lb.line_type IN (
      'labour', 'fencing', 'patio', 'make safe', 'general labour',
      'crew_work_order_deduction', 'labour_deduction',
      'work order', 'work_order', 'group share'
    ) THEN 'labour'
    WHEN lb.line_type IN ('materials', 'materials_deduction') THEN 'materials'
    WHEN lb.line_type = 'commission' THEN 'commission'
    WHEN lb.line_type IN (
      'travel', 'equipment', 'other', 'travel_logistics_deduction'
    ) THEN 'other'
    ELSE 'unclassified'
  END AS cost_lane,
  CASE
    WHEN j_direct.id IS NOT NULL THEN 'job_id'
    WHEN j_line.id IS NOT NULL THEN 'line_job_number'
    WHEN j_desc.id IS NOT NULL THEN 'description_job_number'
    ELSE 'unresolved'
  END AS match_method,
  lb.is_probable_test_line,
  CASE
    WHEN lb.is_probable_test_line THEN 'qa_or_delete_test_line'
    ELSE NULL
  END AS exclusion_reason,
  lb.flag_type,
  lb.baseline_hours,
  lb.baseline_source,
  lb.hours_justification,
  lb.flagged_at,
  (lb.flag_type IS NOT NULL) AS is_hours_flagged
FROM line_base lb
JOIN public.trade_invoices ti ON ti.id = lb.trade_invoice_id
LEFT JOIN public.jobs j_direct
  ON j_direct.id = lb.job_id
 AND j_direct.org_id = ti.org_id
LEFT JOIN public.jobs j_line
  ON j_line.job_number = lb.line_job_number
 AND j_line.org_id = ti.org_id
 AND j_direct.id IS NULL
LEFT JOIN public.jobs j_desc
  ON j_desc.job_number = lb.description_job_number
 AND j_desc.org_id = ti.org_id
 AND j_direct.id IS NULL
 AND j_line.id IS NULL;


COMMENT ON VIEW public.v_trade_charge_resolved IS
  'Canonical trade-cost resolver with hours-flag facts and weekly typed deduction lanes. Work-order pay lines (work order, work_order) and group work order shares (group share) are labour. A commission advance (labour or commission typed, described as a commission advance) is lane advance: not a job cost until earned. Final payout deductions stay non-job/unresolved.';

REVOKE ALL ON public.v_trade_charge_resolved FROM anon, authenticated;
GRANT SELECT ON public.v_trade_charge_resolved TO service_role, postgres;

CREATE OR REPLACE VIEW public.v_job_cost_events AS
WITH trade_mirror_bill AS (
  SELECT x.xero_invoice_id
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCPAY'
    AND (
      EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = x.xero_invoice_id)
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li
        WHERE li.value ->> 'Description' ~ '\| SW - [A-Z]'
      )
    )
),
trade AS (
  SELECT
    r.resolved_job_id AS job_id,
    COALESCE(r.line_date, r.week_start) AS event_date,
    CASE WHEN r.cost_lane = 'unclassified' THEN 'other' ELSE r.cost_lane END AS lane,
    r.cost_lane AS lane_detail,
    'trade'::text AS party_kind,
    r.user_id::text AS party_id,
    COALESCE(NULLIF(btrim(u.name), ''), 'Unnamed trade') AS party,
    r.line_total_ex AS amount_ex,
    'trade_line'::text AS source,
    r.line_id::text AS source_id,
    ti.id::text AS document_id,
    ti.invoice_number AS document_number,
    ti.status AS document_status,
    (ti.status = 'paid' OR upper(COALESCE(ti.xero_bill_status, '')) = 'PAID') AS paid,
    ti.paid_at AS paid_on,
    CASE r.match_method
      WHEN 'job_id' THEN 'high'
      WHEN 'line_job_number' THEN 'medium'
      ELSE 'low'
    END AS confidence,
    (r.cost_lane <> 'advance') AS is_actual,
    r.description,
    r.total_hours AS hours,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    r.match_method,
    COALESCE(c.zero_line OR c.mismatch, false) AS incomplete_invoice
  FROM public.v_trade_charge_resolved r
  JOIN public.trade_invoices ti ON ti.id = r.trade_invoice_id
  LEFT JOIN public.users u ON u.id = r.user_id
  LEFT JOIN public.v_invoice_line_completeness c ON c.trade_invoice_id = r.trade_invoice_id
  WHERE r.resolved_job_id IS NOT NULL
    AND NOT r.is_probable_test_line
    AND ti.status <> 'ops-reject'
    AND upper(COALESCE(ti.xero_bill_status, '')) NOT IN ('DELETED', 'VOIDED')
),
-- The company's super on a trade invoice, on the job of each line it was
-- charged on. Super is 12% of the submitted total. What the worker gave up is
-- the submitted total less the net pay, so the company's part is the super less
-- that: none when the worker paid it all (28 Aug-17 Sep), half on the 6/6
-- split, all of it on a full employer-super group share. The worker's part is
-- inside the line amount already and is never taken off the job's cost. An
-- invoice with no super or net pay recorded gets no row: unknown, not zero.
-- Paid to the fund separately, so never marked paid here. Switch:
-- feature_flags job_cost_employer_super_v1 (added off; turned on at release).
trade_employer_super AS (
  SELECT
    t.job_id,
    t.event_date,
    t.lane,
    'employer_super'::text AS lane_detail,
    t.party_kind,
    t.party_id,
    t.party,
    round(t.amount_ex * s.employer_super_ex / s.subtotal_ex, 6) AS amount_ex,
    'trade_employer_super'::text AS source,
    t.source_id || ':employer_super' AS source_id,
    t.document_id,
    t.document_number,
    t.document_status,
    false AS paid,
    NULL::date AS paid_on,
    t.confidence,
    t.is_actual,
    'Employer super on: ' || COALESCE(t.description, '') AS description,
    NULL::numeric AS hours,
    t.account_code,
    t.business_unit,
    t.match_method,
    t.incomplete_invoice
  FROM trade t
  JOIN (
    SELECT ti.id::text AS document_id,
           ti.subtotal_ex,
           ti.super_amount - (ti.subtotal_ex - ti.net_pay) AS employer_super_ex
    FROM public.trade_invoices ti
    WHERE ti.super_amount IS NOT NULL
      AND ti.net_pay IS NOT NULL
      AND ti.subtotal_ex > 0
  ) s ON s.document_id = t.document_id
  WHERE s.employer_super_ex > 0.005
    AND t.amount_ex <> 0
    AND EXISTS (SELECT 1 FROM public.feature_flags ff
                WHERE ff.flag_name = 'job_cost_employer_super_v1' AND ff.enabled)
),
bill_line AS (
  SELECT
    x.job_id,
    x.invoice_date,
    x.xero_invoice_id,
    x.invoice_number,
    x.contact_name,
    x.status,
    x.fully_paid_on,
    li.n,
    li.value AS line,
    CASE
      WHEN li.value ? '_header_ex' THEN public.job_profit_num(li.value -> '_header_ex')
      WHEN x.raw_json ->> 'LineAmountTypes' = 'Inclusive'
        THEN COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0)
           - COALESCE(public.job_profit_num(li.value -> 'TaxAmount'), 0)
      ELSE COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0)
    END AS amount_ex,
    public.job_cost_credit_share(x.raw_json, x.total) AS credit_share,
    -- JP-12: an installer bill counts on its Xero job only once a person
    -- placed it there; one a person marked not job related never counts.
    CASE
      WHEN NOT public.job_cost_installer_bill(x.line_items) THEN 'not_installer'
      WHEN EXISTS (SELECT 1 FROM public.job_materials_facts f
                    WHERE f.xero_invoice_id = x.xero_invoice_id AND f.job_id = x.job_id
                      AND f.automation_source IN ('manual_queue', 'agent_ai')) THEN 'confirmed'
      WHEN EXISTS (SELECT 1 FROM public.materials_reconciliation_queue q
                    WHERE q.xero_invoice_id = x.xero_invoice_id AND q.status = 'not_job_related') THEN 'not_job_related'
      ELSE 'unconfirmed'
    END AS installer_state
  FROM public.xero_invoices x
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(x.line_items) = 'array' AND jsonb_array_length(x.line_items) > 0 THEN x.line_items
      ELSE jsonb_build_array(jsonb_build_object('_header_ex', x.sub_total, 'Description', 'Bill total (no lines stored)'))
    END
  ) WITH ORDINALITY AS li(value, n)
  WHERE x.invoice_type = 'ACCPAY'
    AND x.status IN ('AUTHORISED', 'PAID')
    AND x.job_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM trade_mirror_bill m WHERE m.xero_invoice_id = x.xero_invoice_id)
    -- CFO-18: a bill with an allocation row on any other job (a person moving
    -- it off the holding card), any split row, or an overhead part is read
    -- through its allocation rows only, never also through xero_invoices.job_id
    -- (so a split or overhead on the bill's own job is never ignored). A bill
    -- placed whole on its own job keeps its richer line detail (as before).
    AND NOT EXISTS (
      SELECT 1 FROM public.job_materials_facts f
      WHERE f.xero_invoice_id = x.xero_invoice_id
        AND (f.job_id IS DISTINCT FROM x.job_id OR f.automation_source = 'manual_split')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.materials_reconciliation_queue q
      WHERE q.xero_invoice_id = x.xero_invoice_id AND COALESCE(q.overhead_ex, 0) > 0
    )
),
supplier AS (
  SELECT
    b.job_id,
    b.invoice_date AS event_date,
    CASE
      WHEN COALESCE(b.line ->> 'Description', '') ~* 'commission' THEN 'commission'
      WHEN b.line ->> 'AccountCode' IN ('306', '301') THEN 'labour'
      WHEN b.line ->> 'AccountCode' ~ '^3[0-9]{2}$' THEN 'materials'
      ELSE 'other'
    END AS lane,
    COALESCE(b.line ->> 'AccountCode', 'no_account') AS lane_detail,
    'supplier'::text AS party_kind,
    NULL::text AS party_id,
    COALESCE(NULLIF(btrim(b.contact_name), ''), 'Unnamed supplier') AS party,
    b.amount_ex,
    CASE b.installer_state
      WHEN 'unconfirmed' THEN 'installer_bill_unconfirmed'
      WHEN 'not_job_related' THEN 'installer_bill_not_job_related'
      ELSE 'supplier_bill'
    END AS source,
    b.xero_invoice_id || ':' || b.n AS source_id,
    b.xero_invoice_id AS document_id,
    b.invoice_number AS document_number,
    b.status AS document_status,
    (b.status = 'PAID') AS paid,
    b.fully_paid_on AS paid_on,
    CASE b.installer_state
      WHEN 'unconfirmed' THEN 'awaiting_confirmation'
      WHEN 'not_job_related' THEN 'person_marked_not_job_related'
      ELSE 'high'
    END AS confidence,
    b.installer_state NOT IN ('unconfirmed', 'not_job_related') AS is_actual,
    b.line ->> 'Description' AS description,
    NULL::numeric AS hours,
    b.line ->> 'AccountCode' AS account_code,
    (SELECT t.value ->> 'Option'
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.line -> 'Tracking') = 'array' THEN b.line -> 'Tracking' ELSE '[]'::jsonb END) t
      WHERE t.value ->> 'Name' = 'Business Unit'
      LIMIT 1) AS business_unit,
    'xero_invoices.job_id'::text AS match_method,
    false AS incomplete_invoice
  FROM bill_line b
),
fact_base AS (
  SELECT
    f.job_id,
    f.fact_date AS event_date,
    CASE WHEN f.lane IN ('labour', 'materials', 'commission', 'other') THEN f.lane ELSE 'materials' END AS lane,
    f.lane AS lane_detail,
    'supplier'::text AS party_kind,
    NULL::text AS party_id,
    COALESCE(NULLIF(btrim(f.contact_name), ''), 'Unnamed supplier') AS party,
    f.amount_ex_gst AS amount_ex,
    'materials_fact'::text AS source,
    f.id::text AS source_id,
    f.xero_invoice_id AS document_id,
    f.invoice_number AS document_number,
    x.status AS document_status,
    COALESCE(x.status = 'PAID', false) AS paid,
    x.fully_paid_on AS paid_on,
    COALESCE(f.confidence, 'unknown') AS confidence,
    true AS is_actual,
    f.match_reason AS description,
    NULL::numeric AS hours,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    COALESCE(f.automation_source, 'materials_fact') AS match_method,
    false AS incomplete_invoice,
    COALESCE(x.status IN ('AUTHORISED', 'PAID'), false) AS bill_live,
    public.job_cost_credit_share(x.raw_json, x.total) AS credit_share,
    -- JP-12: installer labour placed by anything but a person is not confirmed.
    (COALESCE(f.automation_source, '') NOT IN ('manual_queue', 'manual_split', 'agent_ai')
      AND (f.lane = 'labour' OR public.job_cost_installer_bill(x.line_items))) AS installer_unconfirmed
  FROM public.job_materials_facts f
  LEFT JOIN public.xero_invoices x
    ON x.xero_invoice_id = f.xero_invoice_id AND x.invoice_type = 'ACCPAY'
  WHERE f.kind = 'actual'
    AND f.job_id IS NOT NULL
    AND f.amount_ex_gst IS NOT NULL
    AND COALESCE(x.status, '') NOT IN ('VOIDED', 'DELETED')
    AND NOT EXISTS (SELECT 1 FROM trade_mirror_bill m WHERE m.xero_invoice_id = f.xero_invoice_id)
    AND NOT EXISTS (
      SELECT 1 FROM bill_line b
      WHERE b.xero_invoice_id = f.xero_invoice_id AND b.job_id = f.job_id
    )
),
fact AS (
  SELECT job_id, event_date, lane, lane_detail, party_kind, party_id, party, amount_ex,
         CASE WHEN installer_unconfirmed THEN 'installer_bill_unconfirmed' ELSE source END AS source,
         source_id, document_id, document_number, document_status, paid, paid_on,
         CASE WHEN installer_unconfirmed THEN 'awaiting_confirmation' ELSE confidence END AS confidence,
         NOT installer_unconfirmed AS is_actual,
         description, hours, account_code, business_unit, match_method, incomplete_invoice
  FROM fact_base
),
-- CFO-20: credit applied in Xero against a live bill reduces cost in proportion
-- on every line or allocation row of that bill (AmountCredited / Total, so GST
-- comes out the same way). Never on a voided or deleted bill.
supplier_credit AS (
  SELECT
    b.job_id,
    b.invoice_date AS event_date,
    s.lane,
    s.lane_detail,
    s.party_kind,
    s.party_id,
    s.party,
    -round(s.amount_ex * b.credit_share, 2) AS amount_ex,
    CASE WHEN s.is_actual THEN 'supplier_credit' ELSE s.source END AS source,
    s.source_id || ':credit' AS source_id,
    s.document_id,
    s.document_number,
    s.document_status,
    s.paid,
    s.paid_on,
    s.confidence,
    s.is_actual,
    'Credit applied in Xero' AS description,
    NULL::numeric AS hours,
    s.account_code,
    s.business_unit,
    'xero_amount_credited'::text AS match_method,
    false AS incomplete_invoice
  FROM supplier s
  JOIN bill_line b ON b.xero_invoice_id || ':' || b.n = s.source_id
  WHERE b.credit_share > 0 AND s.amount_ex <> 0
),
fact_credit AS (
  SELECT
    f.job_id, f.event_date, f.lane, f.lane_detail, f.party_kind, f.party_id, f.party,
    -round(f.amount_ex * f.credit_share, 2) AS amount_ex,
    CASE WHEN f.installer_unconfirmed THEN 'installer_bill_unconfirmed' ELSE 'supplier_credit' END AS source,
    f.source_id || ':credit' AS source_id,
    f.document_id, f.document_number, f.document_status, f.paid, f.paid_on,
    CASE WHEN f.installer_unconfirmed THEN 'awaiting_confirmation' ELSE f.confidence END AS confidence,
    NOT f.installer_unconfirmed AS is_actual,
    'Credit applied in Xero' AS description,
    NULL::numeric AS hours, f.account_code, f.business_unit,
    'xero_amount_credited'::text AS match_method,
    false AS incomplete_invoice
  FROM fact_base f
  WHERE f.bill_live AND f.credit_share > 0 AND f.amount_ex <> 0
),
po_base AS (
  SELECT
    p.id,
    p.job_id,
    p.po_number,
    p.supplier_name,
    p.status,
    p.notes,
    p.delivery_date,
    p.created_at,
    p.invoice_received_at,
    -- A positive subtotal, else a positive total less GST; otherwise no price.
    -- A 0 subtotal never hides a known total, and no price is never $0.
    CASE WHEN p.subtotal > 0 THEN p.subtotal WHEN p.total > 0 THEN p.total / 1.1 END AS po_amount_ex,
    NOT (COALESCE(p.subtotal, 0) > 0 OR COALESCE(p.total, 0) > 0) AS unpriced,
    COALESCE(
      (SELECT min(oe.sent_at) FROM public.job_order_emails oe
        WHERE oe.purchase_order_id = p.id AND oe.status = 'sent' AND oe.sent_at IS NOT NULL),
      p.last_sent_at,
      p.created_at
    ) AS ordered_at
  FROM public.purchase_orders p
  WHERE p.job_id IS NOT NULL
    AND p.xero_bill_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.job_materials_facts f
      WHERE f.matched_po_id = p.id AND f.kind = 'actual'
    )
    AND lower(COALESCE(p.status, '')) NOT IN ('draft', 'billed', 'cancelled', 'canceled', 'void', 'voided', 'deleted')
),
po_state AS (
  SELECT
    b.*,
    CASE
      WHEN b.invoice_received_at IS NOT NULL THEN 'po_invoice_emailed'
      WHEN b.unpriced THEN 'po_ordered'
      ELSE 'po_committed'
    END AS state
  FROM po_base b
),
po AS (
  SELECT
    s.job_id,
    CASE s.state
      WHEN 'po_invoice_emailed' THEN (s.invoice_received_at AT TIME ZONE 'Australia/Perth')::date
      WHEN 'po_ordered' THEN (s.ordered_at AT TIME ZONE 'Australia/Perth')::date
      ELSE COALESCE(s.delivery_date, s.created_at::date)
    END AS event_date,
    'materials'::text AS lane,
    'purchase_order'::text AS lane_detail,
    'supplier'::text AS party_kind,
    NULL::text AS party_id,
    COALESCE(NULLIF(btrim(s.supplier_name), ''), 'Unnamed supplier') AS party,
    CASE WHEN s.unpriced THEN NULL::numeric ELSE s.po_amount_ex END AS amount_ex,
    s.state AS source,
    s.id::text AS source_id,
    s.id::text AS document_id,
    s.po_number AS document_number,
    s.status AS document_status,
    false AS paid,
    NULL::date AS paid_on,
    CASE s.state
      WHEN 'po_invoice_emailed' THEN 'invoice_emailed'
      WHEN 'po_ordered' THEN 'ordered_not_billed'
      ELSE 'committed'
    END AS confidence,
    false AS is_actual,
    s.notes AS description,
    NULL::numeric AS hours,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    'purchase_orders.job_id'::text AS match_method,
    false AS incomplete_invoice
  FROM po_state s
)
SELECT * FROM trade
UNION ALL SELECT * FROM trade_employer_super
UNION ALL SELECT * FROM supplier
UNION ALL SELECT * FROM fact
UNION ALL SELECT * FROM supplier_credit
UNION ALL SELECT * FROM fact_credit
UNION ALL SELECT * FROM po;


COMMENT ON VIEW public.v_job_cost_events IS
  'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800, 20261030170000): one row per job cost, lane labour/materials/commission/other (advance rows are never actual), source trade_line/trade_employer_super/supplier_bill/materials_fact/supplier_credit/installer_bill_unconfirmed/installer_bill_not_job_related/po_committed/po_ordered/po_invoice_emailed. trade_employer_super is the company''s super on each trade line (super less what the worker gave up), in the line''s lane, never marked paid; no row where super or net pay is not recorded. A bill with an allocation row on another job is read through its rows only. supplier_credit is credit applied in Xero against a live bill, negative, in proportion. An installer bill (306/301) counts only once a person or the AI bill reader (agent_ai, 20261028173000) placed it on the job (JP-12): until then it is installer_bill_unconfirmed (and its credit too), and one a person marked not job related is installer_bill_not_job_related; neither is ever actual. The three po_ sources are never actual. Read only, service role only.';

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('job_cost_employer_super_v1', false,
        'Job Profit counts the company''s super on crew pay as job labour cost (20261030170000).')
ON CONFLICT (flag_name) DO NOTHING;
