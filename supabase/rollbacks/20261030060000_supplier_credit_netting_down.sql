-- Rollback for 20261030060000_supplier_credit_netting.sql (TP-07 slice 2).
-- Puts back what the migration replaced, byte for byte: v_job_cost_events to
-- 20261028173000's body (no credit note rows; CFO-20's bill-side credit
-- unchanged), v_supplier_credit_placement to 20261030010000's twenty columns,
-- and xero_tieout_monthly to 20261029121500's body (credit notes
-- not_yet_read). Drops v_supplier_credit_allocations and
-- job_cost_credit_note_part. Keeps the credit note copy (slice 1's).
-- Each object is restored only while it is this migration's, so a second run
-- is a no-op; an object of the same name that is neither this migration's nor
-- the one it replaced is refused, and nothing changes.
-- Run before 20261030010000's down (which refuses while this placement view
-- is live).

DO $down$
DECLARE
  problems text[] := '{}';
  cmt text;
BEGIN
  IF to_regclass('public.v_job_cost_events') IS NULL THEN
    problems := problems || 'public.v_job_cost_events is missing'::text;
  ELSE
    cmt := COALESCE(obj_description('public.v_job_cost_events'::regclass, 'pg_class'), '');
    IF cmt NOT LIKE 'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800, TP-07 20261030060000):%'
       AND (cmt NOT LIKE 'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800):%'
            OR pg_get_viewdef('public.v_job_cost_events'::regclass) LIKE '%xero_credit_note%') THEN
      problems := problems || 'public.v_job_cost_events is neither 20261030060000''s nor 20261028173000''s'::text;
    END IF;
  END IF;
  IF to_regclass('public.v_supplier_credit_placement') IS NOT NULL THEN
    cmt := COALESCE(obj_description('public.v_supplier_credit_placement'::regclass, 'pg_class'), '');
    IF cmt NOT LIKE 'Supplier credit netting (20261030060000%' AND cmt NOT LIKE 'Supplier credit notes (20261030010000%' THEN
      problems := problems || 'public.v_supplier_credit_placement is neither 20261030060000''s nor 20261030010000''s'::text;
    END IF;
    IF cmt LIKE 'Supplier credit netting (20261030060000%'
       AND (to_regclass('public.xero_supplier_credit_notes') IS NULL OR to_regclass('public.xero_supplier_credit_note_allocations') IS NULL) THEN
      problems := problems || 'the credit note copy (20261030010000) is missing, so its placement view cannot be put back'::text;
    END IF;
  END IF;
  IF to_regclass('public.v_supplier_credit_allocations') IS NOT NULL
     AND COALESCE(obj_description(to_regclass('public.v_supplier_credit_allocations'), 'pg_class'), '') NOT LIKE 'Supplier credit netting (20261030060000%' THEN
    problems := problems || 'public.v_supplier_credit_allocations is not 20261030060000''s'::text;
  END IF;
  IF to_regprocedure('public.job_cost_credit_note_part(numeric,numeric,numeric)') IS NOT NULL
     AND COALESCE(obj_description(to_regprocedure('public.job_cost_credit_note_part(numeric,numeric,numeric)'), 'pg_proc'), '') NOT LIKE 'Supplier credit netting (20261030060000%' THEN
    problems := problems || 'public.job_cost_credit_note_part is not 20261030060000''s'::text;
  END IF;
  IF to_regprocedure('public.xero_tieout_monthly(date,integer,uuid)') IS NOT NULL
     AND COALESCE(obj_description(to_regprocedure('public.xero_tieout_monthly(date,integer,uuid)'), 'pg_proc'), '') NOT LIKE 'TP-01 Xero tie-out (20261029121500)%' THEN
    problems := problems || 'public.xero_tieout_monthly is neither 20261030060000''s nor 20261029121500''s'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'supplier_credit_netting_down_preimage_mismatch: %', array_to_string(problems, '; ');
  END IF;
END
$down$;

-- 1. The placement view: slice 1's twenty columns (a view cannot lose columns
--    in place, so it is dropped and made again).
DO $placement$
BEGIN
  IF COALESCE(obj_description(to_regclass('public.v_supplier_credit_placement'), 'pg_class'), '') LIKE 'Supplier credit netting (20261030060000%' THEN
    DROP VIEW public.v_supplier_credit_placement;
    EXECUTE $sql$CREATE OR REPLACE VIEW public.v_supplier_credit_placement
WITH (security_invoker = true) AS
WITH note AS (
  SELECT n.*, COALESCE(n.status IN ('AUTHORISED', 'PAID'), false) AS live
  FROM public.xero_supplier_credit_notes n
),
alloc AS (
  SELECT
    n.org_id, n.xero_credit_note_id, n.credit_note_number, n.xero_contact_id, n.contact_name,
    n.credit_note_date, n.status AS credit_note_status, n.live,
    a.n, a.allocation_id, a.xero_invoice_id, a.invoice_number, a.amount, a.allocation_date, a.is_deleted,
    x.invoice_type AS bill_type, x.status AS bill_status, x.total AS bill_total,
    -- The same allocation seen from the bill's own copy, which CFO-20 counts.
    (SELECT sum(public.job_profit_num(c.value -> 'AppliedAmount'))
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.raw_json -> 'CreditNotes') = 'array' THEN x.raw_json -> 'CreditNotes' ELSE '[]'::jsonb END) c
      WHERE COALESCE(c.value ->> 'CreditNoteID', c.value ->> 'ID') = a.xero_credit_note_id) AS bill_side_applied,
    x.xero_invoice_id IS NOT NULL AS bill_in_copy
  FROM note n
  JOIN public.xero_supplier_credit_note_allocations a
    ON a.org_id = n.org_id AND a.xero_credit_note_id = n.xero_credit_note_id
  LEFT JOIN public.xero_invoices x
    ON x.org_id = a.org_id AND x.xero_invoice_id = a.xero_invoice_id AND x.invoice_type = 'ACCPAY'
  WHERE n.allocations_returned
),
-- The bill's placement in Job Profit: its supplier rows (never its credit
-- rows), summed per job. Ex GST, as v_job_cost_events carries them.
bill_part AS (
  SELECT e.document_id AS xero_invoice_id, e.job_id, sum(e.amount_ex) AS part_ex, bool_and(e.is_actual) AS part_is_actual
  FROM public.v_job_cost_events e
  WHERE e.party_kind = 'supplier'
    AND e.match_method IS DISTINCT FROM 'xero_amount_credited'
    AND e.source IN ('supplier_bill', 'materials_fact', 'installer_bill_unconfirmed', 'installer_bill_not_job_related')
    AND e.job_id IS NOT NULL
    AND e.document_id IN (SELECT a.xero_invoice_id FROM public.xero_supplier_credit_note_allocations a)
  GROUP BY e.document_id, e.job_id
),
judged AS (
  SELECT a.*,
    CASE
      WHEN NOT a.live THEN 'credit_note_not_live'
      WHEN a.is_deleted THEN 'allocation_deleted'
      WHEN a.amount IS NULL THEN 'amount_unknown'
      WHEN NOT a.bill_in_copy THEN 'bill_not_in_copy'
      WHEN a.bill_status IS NULL OR a.bill_status NOT IN ('AUTHORISED', 'PAID') THEN 'bill_not_live'
      WHEN a.bill_total IS NULL OR a.bill_total <= 0 THEN 'bill_total_unknown'
      WHEN NOT EXISTS (SELECT 1 FROM bill_part p WHERE p.xero_invoice_id = a.xero_invoice_id) THEN 'bill_not_placed'
      ELSE 'placed'
    END AS state
  FROM alloc a
)
-- Placed: one row per job the bill sits on, at CFO-20's rule.
SELECT j.org_id, j.xero_credit_note_id, j.credit_note_number, j.xero_contact_id, j.contact_name, j.credit_note_date,
       j.credit_note_status, j.n AS allocation_n, j.allocation_id, j.xero_invoice_id, j.invoice_number, j.bill_status,
       j.allocation_date, j.amount AS amount, 'placed'::text AS state,
       p.job_id, p.part_ex AS bill_part_ex, round(p.part_ex * j.amount / j.bill_total, 2) AS credit_ex,
       p.part_is_actual, j.bill_side_applied
  FROM judged j
  JOIN bill_part p ON p.xero_invoice_id = j.xero_invoice_id
 WHERE j.state = 'placed'
UNION ALL
-- Every other allocation: no job.
SELECT j.org_id, j.xero_credit_note_id, j.credit_note_number, j.xero_contact_id, j.contact_name, j.credit_note_date,
       j.credit_note_status, j.n, j.allocation_id, j.xero_invoice_id, j.invoice_number, j.bill_status,
       j.allocation_date, j.amount, j.state,
       NULL::uuid, NULL::numeric, NULL::numeric, NULL::boolean, j.bill_side_applied
  FROM judged j
 WHERE j.state <> 'placed'
UNION ALL
-- Credit still on a live note: on no bill and no job, its amount shown
-- (Xero's RemainingCredit), or unknown when Xero did not send it.
SELECT n.org_id, n.xero_credit_note_id, n.credit_note_number, n.xero_contact_id, n.contact_name, n.credit_note_date,
       n.status, NULL::integer, NULL::text, NULL::text, NULL::text, NULL::text,
       NULL::date, n.remaining_credit,
       CASE WHEN n.remaining_credit IS NULL THEN 'remaining_unknown' ELSE 'unallocated' END,
       NULL::uuid, NULL::numeric, NULL::numeric, NULL::boolean, NULL::numeric
  FROM note n
 WHERE n.live AND (n.remaining_credit IS NULL OR n.remaining_credit > 0)
UNION ALL
-- A live note whose record came without its Allocations list.
SELECT n.org_id, n.xero_credit_note_id, n.credit_note_number, n.xero_contact_id, n.contact_name, n.credit_note_date,
       n.status, NULL::integer, NULL::text, NULL::text, NULL::text, NULL::text,
       NULL::date, NULL::numeric, 'allocations_not_read'::text,
       NULL::uuid, NULL::numeric, NULL::numeric, NULL::boolean, NULL::numeric
  FROM note n
 WHERE n.live AND NOT n.allocations_returned$sql$;
    EXECUTE $sql$COMMENT ON VIEW public.v_supplier_credit_placement IS
  'Supplier credit notes (20261030010000, TP-07 slice 1): where each supplier credit note allocation lands. state placed: one row per job the reversed bill sits on in Job Profit (v_job_cost_events'' supplier rows for that bill), credit_ex = bill part ex GST x allocation / bill total (CFO-20''s rule). Every other row has no job: unallocated (credit left on a live note, Xero''s RemainingCredit, never $0), remaining_unknown, allocations_not_read, credit_note_not_live (voided, deleted, draft, submitted or no status: never placed), allocation_deleted, amount_unknown, bill_not_in_copy, bill_not_live, bill_total_unknown, bill_not_placed. bill_side_applied: the same allocation as the bill''s own copy lists it (raw_json CreditNotes), which v_job_cost_events already takes off the job since CFO-20; slice 2 counts one side, never both. Changes no money figure: nothing reads it yet. Read only, service role only.'$sql$;
    REVOKE ALL ON public.v_supplier_credit_placement FROM PUBLIC, anon, authenticated;
    GRANT SELECT ON public.v_supplier_credit_placement TO service_role;
  END IF;
END
$placement$;

-- 2. v_job_cost_events: 20261028173000's body.
DO $engine$
BEGIN
  IF COALESCE(obj_description(to_regclass('public.v_job_cost_events'), 'pg_class'), '')
     LIKE 'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800, TP-07 20261030060000):%' THEN
    EXECUTE $sql$CREATE OR REPLACE VIEW public.v_job_cost_events AS
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
UNION ALL SELECT * FROM supplier
UNION ALL SELECT * FROM fact
UNION ALL SELECT * FROM supplier_credit
UNION ALL SELECT * FROM fact_credit
UNION ALL SELECT * FROM po$sql$;
    EXECUTE $sql$COMMENT ON VIEW public.v_job_cost_events IS
  'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800): one row per job cost, lane labour/materials/commission/other, source trade_line/supplier_bill/materials_fact/supplier_credit/installer_bill_unconfirmed/installer_bill_not_job_related/po_committed/po_ordered/po_invoice_emailed. A bill with an allocation row on another job is read through its rows only. supplier_credit is credit applied in Xero against a live bill, negative, in proportion. An installer bill (306/301) counts only once a person or the AI bill reader (agent_ai, 20261028173000) placed it on the job (JP-12): until then it is installer_bill_unconfirmed (and its credit too), and one a person marked not job related is installer_bill_not_job_related; neither is ever actual. The three po_ sources are never actual. Read only, service role only.'$sql$;
    REVOKE ALL ON public.v_job_cost_events FROM PUBLIC, anon, authenticated;
    GRANT SELECT ON public.v_job_cost_events TO service_role;
  END IF;
END
$engine$;

-- 3. The side rule and the per-row part (nothing reads them now).
DROP VIEW IF EXISTS public.v_supplier_credit_allocations;
DROP FUNCTION IF EXISTS public.job_cost_credit_note_part(numeric, numeric, numeric);

-- 4. The TP-01 tie-out: 20261029121500's body.
DO $tieout$
BEGIN
  IF COALESCE(obj_description(to_regprocedure('public.xero_tieout_monthly(date,integer,uuid)'), 'pg_proc'), '')
     LIKE 'TP-01 Xero tie-out (20261029121500), supplier credit notes TP-07 (20261030060000)%' THEN
    EXECUTE $sql$CREATE OR REPLACE FUNCTION public.xero_tieout_monthly(p_as_of date DEFAULT NULL, p_months integer DEFAULT 12, p_org_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH win AS (
    SELECT a.as_of,
           m.months,
           (date_trunc('month', a.as_of) - make_interval(months => m.months - 1))::date AS from_month,
           (date_trunc('month', a.as_of) + interval '1 month')::date AS to_excl,
           (date_trunc('month', a.as_of) - interval '5 months')::date AS six_from
      FROM (SELECT COALESCE(p_as_of, (now() AT TIME ZONE 'Australia/Perth')::date) AS as_of) a,
           (SELECT GREATEST(1, LEAST(COALESCE(p_months, 12), 120)) AS months) m
  ),
  bills AS (
    SELECT DISTINCT ON (x.org_id, x.xero_invoice_id)
           x.org_id, x.xero_invoice_id, x.status, x.invoice_date, x.job_id, x.line_items,
           round(x.sub_total, 2) AS bill_ex, round(x.total, 2) AS bill_inc
      FROM public.xero_invoices x
     WHERE x.invoice_type = 'ACCPAY'
       AND x.xero_invoice_id IS NOT NULL
       AND (p_org_id IS NULL OR x.org_id = p_org_id)
     ORDER BY x.org_id, x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC
  ),
  b1 AS (
    SELECT b.org_id, b.xero_invoice_id, b.invoice_date, b.bill_ex, b.bill_inc,
           date_trunc('month', b.invoice_date)::date AS month,
           -- In the total: a bill of 0 or more. Below 0: negative_bill only.
           (b.bill_ex IS NOT NULL AND b.bill_ex >= 0) AS counted,
           (b.bill_ex IS NOT NULL AND b.bill_ex < 0) AS negative,
           public.materials_ai_trade_mirror(b.xero_invoice_id, b.line_items) AS mirror,
           public.job_cost_installer_bill(b.line_items) AS installer,
           q.status AS queue_status,
           round(GREATEST(COALESCE(q.overhead_ex, 0), 0), 2) AS overhead_part,
           COALESCE(a.n, 0) AS row_count,
           round(COALESCE(a.job_rows_ex, 0), 2) AS job_rows_ex,
           round(COALESCE(a.hold_rows_ex, 0), 2) AS hold_rows_ex,
           COALESCE(a.person_placed, false) AS person_placed,
           CASE WHEN b.job_id IS NULL THEN 'none'
                WHEN xj.id IS NULL THEN 'unknown_job'
                WHEN lower(COALESCE(xj.metadata ->> 'do_not_schedule', '')) = 'true' THEN 'holding'
                ELSE 'job' END AS xero_link
      FROM bills b
      -- The bill's allocation rows, summed per bill (so no bill is counted
      -- twice). A row with no org is read as its bill's org.
      LEFT JOIN LATERAL (
        SELECT count(*) AS n,
               sum(f.amount_ex_gst) FILTER (WHERE NOT f.hold) AS job_rows_ex,
               sum(f.amount_ex_gst) FILTER (WHERE f.hold) AS hold_rows_ex,
               bool_or(f.automation_source IN ('manual_queue', 'manual_split', 'agent_ai')) AS person_placed
          FROM (SELECT f.amount_ex_gst, f.automation_source,
                       lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) = 'true' AS hold
                  FROM public.job_materials_facts f
                  LEFT JOIN public.jobs j ON j.id = f.job_id
                 WHERE f.kind = 'actual'
                   AND f.xero_invoice_id = b.xero_invoice_id
                   AND COALESCE(f.org_id, b.org_id) = b.org_id) f
      ) a ON true
      LEFT JOIN public.materials_reconciliation_queue q ON q.org_id = b.org_id AND q.xero_invoice_id = b.xero_invoice_id
      LEFT JOIN public.jobs xj ON xj.id = b.job_id
     CROSS JOIN win
     WHERE b.status IN ('AUTHORISED', 'PAID')
       -- Only the months read (and undated bills, so none is silently dropped).
       AND (b.invoice_date IS NULL
            OR (b.invoice_date >= LEAST(win.from_month, win.six_from) AND b.invoice_date < win.to_excl))
  ),
  b2 AS (
    SELECT b1.*,
           (row_count > 0 OR overhead_part > 0) AS by_rows,
           -- JP-12: a machine's installer placement is not on a job yet.
           (installer AND NOT person_placed AND overhead_part = 0) AS installer_gate
      FROM b1
  ),
  b3 AS (
    SELECT b2.*,
           -- Overhead first, capped at the bill.
           CASE WHEN NOT counted OR mirror THEN 0
                WHEN by_rows THEN LEAST(overhead_part, bill_ex)
                WHEN queue_status = 'not_job_related' THEN bill_ex
                ELSE 0 END AS overhead_ex,
           CASE WHEN NOT counted OR mirror THEN 0
                WHEN by_rows THEN CASE WHEN installer_gate THEN 0 ELSE GREATEST(job_rows_ex, 0) END
                WHEN queue_status = 'not_job_related' THEN 0
                WHEN xero_link = 'job' AND NOT installer_gate THEN bill_ex
                ELSE 0 END AS job_basis,
           -- Everything the rows (summed with their signs) and the overhead part
           -- claim, above the bill. A trade-app labour bill is read whole and its
           -- rows are not read, so it is never over allocated.
           CASE WHEN counted AND NOT mirror AND by_rows
                THEN GREATEST(job_rows_ex + hold_rows_ex + overhead_part - bill_ex, 0)
                ELSE 0 END AS over_ex
      FROM b2
  ),
  b4 AS (
    SELECT b3.*,
           CASE WHEN counted AND mirror THEN bill_ex ELSE 0 END AS mirror_ex,
           -- Job rows next, capped at what overhead left of the bill.
           LEAST(job_basis, CASE WHEN counted THEN bill_ex - overhead_ex ELSE 0 END) AS on_job_ex
      FROM b3
  ),
  placed AS (
    SELECT b4.*,
           CASE WHEN NOT counted OR mirror THEN 0
                ELSE bill_ex - overhead_ex - on_job_ex END AS unplaced_ex
      FROM b4
  ),
  sorted AS (
    SELECT p.*,
           CASE WHEN p.unplaced_ex = 0 THEN NULL
                WHEN p.installer_gate AND (p.job_rows_ex > 0 OR (NOT p.by_rows AND p.xero_link = 'job')) THEN 'installer_awaiting_confirmation'
                WHEN p.hold_rows_ex > 0 OR (NOT p.by_rows AND p.xero_link = 'holding') THEN 'holding_job'
                WHEN p.queue_status = 'open' THEN 'waiting_in_bills_to_place'
                WHEN p.queue_status IS NULL AND NOT p.by_rows THEN 'not_in_intake'
                ELSE 'rows_short_of_bill' END AS unplaced_reason
      FROM placed p
  ),
  months AS (
    SELECT g::date AS month
      FROM win, generate_series(win.from_month::timestamp, (win.to_excl - 1)::timestamp, interval '1 month') g
  ),
  -- The month's bills read straight from the copy, not through any join, for
  -- parts_add_up.
  direct AS (
    SELECT date_trunc('month', b.invoice_date)::date AS month, sum(b.bill_ex) AS ex
      FROM bills b
     WHERE b.status IN ('AUTHORISED', 'PAID') AND b.bill_ex >= 0
     GROUP BY 1
  ),
  not_counted AS (
    SELECT date_trunc('month', b.invoice_date)::date AS month, count(*) AS n, sum(b.bill_ex) AS ex
      FROM bills b
     WHERE b.status IN ('DRAFT', 'SUBMITTED')
     GROUP BY 1
  ),
  spend AS (
    SELECT date_trunc('month', t.txn_date)::date AS month,
           count(*) AS n,
           CASE WHEN bool_and(t.sub_total IS NOT NULL) THEN sum(abs(t.sub_total)) END AS ex
      FROM public.xero_bank_transactions t
     WHERE t.txn_type = 'SPEND'
       AND upper(COALESCE(t.status, '')) NOT IN ('DELETED', 'VOIDED')
       AND (p_org_id IS NULL OR t.org_id = p_org_id)
     GROUP BY 1
  ),
  month_rows AS (
    SELECT m.month,
           count(s.xero_invoice_id) FILTER (WHERE s.counted OR s.bill_ex IS NULL) AS bills,
           COALESCE(sum(s.bill_ex) FILTER (WHERE s.counted), 0) AS total_ex,
           COALESCE(sum(s.bill_inc) FILTER (WHERE s.counted), 0) AS total_inc,
           count(s.xero_invoice_id) FILTER (WHERE s.bill_ex IS NULL) AS amount_unknown,
           COALESCE(sum(s.on_job_ex), 0) AS on_job_ex,
           COALESCE(sum(s.overhead_ex), 0) AS overhead_ex,
           COALESCE(sum(s.mirror_ex), 0) AS mirror_ex,
           COALESCE(sum(s.unplaced_ex), 0) AS unplaced_ex,
           COALESCE(sum(s.over_ex), 0) AS over_ex,
           count(s.xero_invoice_id) FILTER (WHERE s.over_ex > 0) AS over_bills,
           count(s.xero_invoice_id) FILTER (WHERE s.negative) AS neg_bills,
           COALESCE(sum(s.bill_ex) FILTER (WHERE s.negative), 0) AS neg_ex,
           COALESCE(sum(s.bill_inc) FILTER (WHERE s.negative), 0) AS neg_inc,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'waiting_in_bills_to_place'), 0) AS r_waiting,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'holding_job'), 0) AS r_holding,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'installer_awaiting_confirmation'), 0) AS r_installer,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'not_in_intake'), 0) AS r_not_in_intake,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'rows_short_of_bill'), 0) AS r_short
      FROM months m
      LEFT JOIN sorted s ON s.month = m.month
     GROUP BY m.month
  ),
  six AS (
    SELECT COALESCE(sum(s.bill_ex) FILTER (WHERE s.counted), 0) AS total_ex,
           COALESCE(sum(s.unplaced_ex), 0) AS unplaced_ex
      FROM sorted s, win
     WHERE s.invoice_date >= win.six_from AND s.invoice_date < win.to_excl
  )
  SELECT jsonb_build_object(
    'as_of', win.as_of,
    'as_of_reads', 'as_of picks the months shown and nothing else. Allocation rows, Bills to place states, overhead parts and holding-job marks are read as they are today, and bills as our copy of Xero holds them today (copy_synced_at).',
    'org_id', p_org_id,
    'months_shown', win.months,
    'from_month', win.from_month,
    'basis', 'ex GST, to the cent; supplier bills (ACCPAY) AUTHORISED or PAID in our copy of Xero, by invoice date; a bill below 0 is shown only as negative_bill',
    'covers', 'bills only',
    'complete', false,
    'copy_synced_at', (SELECT max(x.synced_at) FROM public.xero_invoices x
                        WHERE x.invoice_type = 'ACCPAY' AND (p_org_id IS NULL OR x.org_id = p_org_id)),
    'not_yet_read', jsonb_build_array(
      jsonb_build_object('part', 'supplier_credit_notes', 'ticket', 'TP-07',
        'why', 'Supplier credit notes (ACCPAYCREDIT) are not copied from Xero yet.'),
      jsonb_build_object('part', 'spend_money', 'ticket', 'TP-08',
        'why', 'Spend money and card spend are not in the bill intake yet. The bank copy holds only reconciled transactions from the last 90 days, so it is shown as a partial look and not counted.'),
      jsonb_build_object('part', 'stock_and_vehicles', 'ticket', 'TP-01',
        'why', 'No bill is marked stock or vehicle in our records yet. A bill a person filed as not job related is in overhead.')),
    'last_6_months', jsonb_build_object(
      'from', win.six_from,
      'to', (win.to_excl - 1),
      'bills_total_ex', six.total_ex,
      'unplaced_ex', six.unplaced_ex,
      'unplaced_share_of_bills', CASE WHEN six.total_ex > 0 THEN (ceil(six.unplaced_ex / six.total_ex * 10000) / 10000)::numeric(8,4) END,
      'accounted_share_of_bills', CASE WHEN six.total_ex > 0 THEN (1 - ceil(six.unplaced_ex / six.total_ex * 10000) / 10000)::numeric(8,4) END),
    'undated_bills', (SELECT jsonb_build_object('count', count(*) FILTER (WHERE NOT s.negative),
                                                'ex', COALESCE(sum(s.bill_ex) FILTER (WHERE s.counted), 0),
                                                'negative_bills', count(*) FILTER (WHERE s.negative))
                        FROM sorted s WHERE s.invoice_date IS NULL),
    'months', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'month', to_char(r.month, 'YYYY-MM'),
        'tie_out_total_ex', r.total_ex,
        'covers', 'bills only',
        'bills', jsonb_build_object(
          'count', r.bills,
          'total_ex', r.total_ex,
          'total_inc', r.total_inc,
          'amount_unknown_count', r.amount_unknown,
          'on_job_ex', r.on_job_ex,
          'trade_app_labour_ex', r.mirror_ex,
          'non_job', jsonb_build_object(
            'overhead_not_job_related_ex', r.overhead_ex,
            'stock_ex', NULL,
            'vehicles_ex', NULL,
            'stock_and_vehicles', 'not_yet_separated'),
          'unplaced_ex', r.unplaced_ex,
          'unplaced_share', CASE WHEN r.total_ex > 0 THEN (ceil(r.unplaced_ex / r.total_ex * 10000) / 10000)::numeric(8,4) END,
          'unplaced_by_reason', jsonb_build_object(
            'waiting_in_bills_to_place', r.r_waiting,
            'holding_job', r.r_holding,
            'installer_awaiting_confirmation', r.r_installer,
            'not_in_intake', r.r_not_in_intake,
            'rows_short_of_bill', r.r_short),
          'over_allocated', jsonb_build_object('bills', r.over_bills, 'ex', r.over_ex, 'counted', false,
            'reads', 'Per bill of 0 or more that is not trade-app labour: job rows + holding-job rows + overhead part - bill, when above 0. Rows are summed with their signs. A trade-app labour bill is read whole, so it is never over allocated.'),
          'negative_bill', jsonb_build_object('bills', r.neg_bills, 'ex', r.neg_ex, 'inc', r.neg_inc, 'counted', false),
          'parts_add_up', (r.on_job_ex + r.mirror_ex + r.overhead_ex + r.unplaced_ex = COALESCE(d.ex, 0)),
          'parts_check', 'on_job + trade_app_labour + overhead + unplaced against the bills read directly from the copy; unplaced is each bill''s remainder, so this catches a bill dropped or counted twice, not a mis-sorted dollar'),
        'not_counted', jsonb_build_object(
          'draft_or_submitted_bills', COALESCE(nc.n, 0),
          'draft_or_submitted_ex', COALESCE(nc.ex, 0)),
        'spend', jsonb_build_object(
          'status', 'not_yet_read',
          'ticket', 'TP-08',
          'amount_ex', NULL,
          'counted', false,
          'bank_copy_partial', jsonb_build_object(
            'rows', COALESCE(sp.n, 0),
            'ex', sp.ex,
            'note', 'Reconciled spend in the rolling 90-day bank copy only; includes supplier prepayments and overpayments; not placed; not counted.')),
        'credit_notes', jsonb_build_object(
          'status', 'not_yet_read',
          'ticket', 'TP-07',
          'amount_ex', NULL,
          'counted', false)
      ) ORDER BY r.month DESC), '[]'::jsonb)
      FROM month_rows r
      LEFT JOIN direct d ON d.month = r.month
      LEFT JOIN not_counted nc ON nc.month = r.month
      LEFT JOIN spend sp ON sp.month = r.month)
  )
  FROM win, six
$$$sql$;
    EXECUTE $sql$COMMENT ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) IS
  'TP-01 Xero tie-out (20261029121500): by month, every AUTHORISED or PAID supplier bill dollar of 0 or more (ex GST) in our copy of Xero sorted into on a job, trade-app labour (already counted on jobs by the trade app), overhead / not job related (stock and vehicles not yet separated) or unplaced, with the unplaced share (rounded up, never below 0) and the last 6 months. A bill below 0 is shown only as negative_bill; rows (summed with their signs) and overhead parts above a bill that is not trade-app labour are shown as over_allocated; neither is in the total. parts_add_up checks the buckets against the bills read directly. p_org_id scopes every read to one org (null reads every org, a bill per org and Xero id). as_of picks the months only: allocations and Bills to place states are as of today. Supplier credit notes (TP-07) and spend money (TP-08) are not_yet_read with null amounts, never $0. Read only, aggregates only, service role only.'$sql$;
    REVOKE ALL ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) TO service_role;
  END IF;
END
$tieout$;
