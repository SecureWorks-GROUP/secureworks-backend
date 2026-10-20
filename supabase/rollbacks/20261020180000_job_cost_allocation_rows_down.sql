-- Down migration for 20261020180000_job_cost_allocation_rows (CFO-18, CFO-20).
-- Restores the engine views to 20261019120000 (cost) and 20261009130000
-- (revenue), the one-row-per-bill index, and the queue and source checks.
-- Fails closed while any bill is split across jobs or a queue row is 'split':
-- undo those splits first (delete the manual_split rows, re-open the rows).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.job_materials_facts GROUP BY xero_invoice_id HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM public.job_materials_facts WHERE automation_source = 'manual_split')
     OR EXISTS (SELECT 1 FROM public.materials_reconciliation_queue WHERE status = 'split' OR overhead_ex IS NOT NULL) THEN
    RAISE EXCEPTION 'cfo18 down: split bills exist; undo them before rolling back';
  END IF;
END $$;

CREATE OR REPLACE VIEW public.v_job_revenue_events AS
SELECT
  x.job_id,
  'invoice_line'::text AS kind,
  x.invoice_date,
  CASE
    WHEN li.value ? '_header_ex' THEN public.job_profit_num(li.value -> '_header_ex')
    WHEN x.raw_json ->> 'LineAmountTypes' = 'Inclusive'
      THEN COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0)
         - COALESCE(public.job_profit_num(li.value -> 'TaxAmount'), 0)
    ELSE COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0)
  END AS amount_ex,
  x.status,
  (x.status = 'PAID') AS paid,
  x.fully_paid_on AS paid_on,
  (x.status IN ('AUTHORISED', 'PAID')) AS counts_as_invoiced,
  x.xero_invoice_id || ':' || li.n AS source_id,
  x.xero_invoice_id AS document_id,
  x.invoice_number AS document_number,
  x.contact_name AS party,
  li.value ->> 'Description' AS description,
  li.value ->> 'AccountCode' AS account_code,
  (SELECT t.value ->> 'Option'
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(li.value -> 'Tracking') = 'array' THEN li.value -> 'Tracking' ELSE '[]'::jsonb END) t
    WHERE t.value ->> 'Name' = 'Business Unit'
    LIMIT 1) AS business_unit,
  false AS agreed
FROM public.xero_invoices x
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(x.line_items) = 'array' AND jsonb_array_length(x.line_items) > 0 THEN x.line_items
    ELSE jsonb_build_array(jsonb_build_object('_header_ex', x.sub_total, 'Description', 'Invoice total (no lines stored)'))
  END
) WITH ORDINALITY AS li(value, n)
WHERE x.invoice_type = 'ACCREC'
  AND x.job_id IS NOT NULL
  AND x.status NOT IN ('VOIDED', 'DELETED')
UNION ALL
SELECT
  v.job_id,
  'variation'::text AS kind,
  COALESCE(v.accepted_at, v.approved_at, v.sent_at, v.created_at)::date AS invoice_date,
  CASE WHEN v.gst_included THEN round(v.amount / 1.1, 2) ELSE v.amount END AS amount_ex,
  v.status,
  false AS paid,
  NULL::date AS paid_on,
  false AS counts_as_invoiced,
  v.id::text AS source_id,
  v.id::text AS document_id,
  'V' || v.variation_number AS document_number,
  NULL::text AS party,
  v.description,
  NULL::text AS account_code,
  NULL::text AS business_unit,
  (
    v.declined_at IS NULL
    AND lower(COALESCE(v.status, '')) NOT IN ('declined', 'rejected')
    AND (v.accepted_at IS NOT NULL OR lower(COALESCE(v.status, '')) IN ('accepted', 'invoiced'))
  ) AS agreed
FROM public.job_variations v
WHERE v.job_id IS NOT NULL;

COMMENT ON VIEW public.v_job_revenue_events IS
  'Job profit engine (20261009130000): sales invoice lines per job (VOIDED/DELETED excluded; counts_as_invoiced for AUTHORISED/PAID) and every variation (counts_as_invoiced false; agreed only when accepted_at is set or status is accepted/invoiced, unless declined_at or declined/rejected status). Read only, service role only.';


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
    true AS is_actual,
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
    END AS amount_ex
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
),
supplier AS (
  SELECT
    b.job_id,
    b.invoice_date AS event_date,
    CASE
      WHEN COALESCE(b.line ->> 'Description', '') ~* 'commission' THEN 'commission'
      WHEN b.line ->> 'AccountCode' = '306' THEN 'labour'
      WHEN b.line ->> 'AccountCode' ~ '^3[0-9]{2}$' THEN 'materials'
      ELSE 'other'
    END AS lane,
    COALESCE(b.line ->> 'AccountCode', 'no_account') AS lane_detail,
    'supplier'::text AS party_kind,
    NULL::text AS party_id,
    COALESCE(NULLIF(btrim(b.contact_name), ''), 'Unnamed supplier') AS party,
    b.amount_ex,
    'supplier_bill'::text AS source,
    b.xero_invoice_id || ':' || b.n AS source_id,
    b.xero_invoice_id AS document_id,
    b.invoice_number AS document_number,
    b.status AS document_status,
    (b.status = 'PAID') AS paid,
    b.fully_paid_on AS paid_on,
    'high'::text AS confidence,
    true AS is_actual,
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
fact AS (
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
    false AS incomplete_invoice
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
UNION ALL SELECT * FROM supplier
UNION ALL SELECT * FROM fact
UNION ALL SELECT * FROM po;

COMMENT ON VIEW public.v_job_cost_events IS
  'Job profit engine (20261009130000, CFO-12 20261019120000): one row per job cost, lane labour/materials/commission/other, source trade_line/supplier_bill/materials_fact/po_committed/po_ordered/po_invoice_emailed. The three po_ sources are never actual (is_actual false): po_committed is a priced open order; po_ordered is a sent order with no price (amount null, counted, never $0); po_invoice_emailed is an order whose supplier invoice was emailed with no bill linked to the order (it may be on the job unlinked). Read only, service role only.';


DROP VIEW IF EXISTS public.v_bill_allocation_balance;
DROP FUNCTION IF EXISTS public.allocate_bill_split(text, jsonb, numeric, text, text);
DROP FUNCTION IF EXISTS public.job_cost_credit_share(jsonb, numeric);

ALTER TABLE public.materials_reconciliation_queue DROP CONSTRAINT IF EXISTS materials_recon_overhead_chk;
ALTER TABLE public.materials_reconciliation_queue DROP CONSTRAINT IF EXISTS materials_recon_status_chk;
ALTER TABLE public.materials_reconciliation_queue ADD CONSTRAINT materials_recon_status_chk
  CHECK (status IN ('open', 'assigned', 'not_job_related', 'void_in_xero'));
ALTER TABLE public.materials_reconciliation_queue
  DROP COLUMN IF EXISTS overhead_note,
  DROP COLUMN IF EXISTS overhead_ex;

ALTER TABLE public.job_materials_facts DROP CONSTRAINT IF EXISTS job_materials_facts_source_chk;
ALTER TABLE public.job_materials_facts ADD CONSTRAINT job_materials_facts_source_chk
  CHECK (automation_source IN ('xero_ref_link', 'po_deterministic', 'manual_queue', 'agent_prematch'));
DROP TRIGGER IF EXISTS job_materials_facts_no_mix ON public.job_materials_facts;
DROP FUNCTION IF EXISTS public.job_materials_facts_no_mix();
DROP INDEX IF EXISTS public.job_materials_facts_invoice_whole_uidx;
DROP INDEX IF EXISTS public.job_materials_facts_invoice_idx;
DROP INDEX IF EXISTS public.job_materials_facts_invoice_job_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS job_materials_facts_invoice_uidx
  ON public.job_materials_facts (xero_invoice_id);

REVOKE ALL ON public.v_job_cost_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_job_revenue_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_job_cost_events TO service_role;
GRANT SELECT ON public.v_job_revenue_events TO service_role;
