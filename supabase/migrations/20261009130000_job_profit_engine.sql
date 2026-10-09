-- 20261009130000_job_profit_engine.sql
--
-- Job profitability, PR 1: one read-only job profit engine for every job type.
--
-- Profit here is GROSS profit on direct costs: trade labour, materials and
-- commission (plus other direct lines). No overhead share. The company's super
-- share on trade labour is not added (a trade line is costed at its own
-- amount ex GST, as job_financials does).
--
-- Objects (all read only, SELECT-only, service role only):
--
--   job_profit_num(jsonb)      a JSON number or plain decimal string, else null
--                              (never 0). Immutable helper.
--   v_job_cost_events          one row per job cost: lane, party, amount ex GST,
--                              source, paid, confidence.
--   v_job_revenue_events       one row per sales invoice line on a job, plus the
--                              job's variations (listed, never summed).
--   v_job_profit               one row per non-legacy job: quoted, expected cost
--                              by lane, actual cost by lane, the Xero Project
--                              expense total as a separate reconciling figure,
--                              one cost basis, invoiced, collected, profit,
--                              margin, paid-verified flags, completeness flags.
--   job_profit(uuid)           v_job_profit for one job.
--
-- Rules that hold the numbers honest:
--
-- 1. Cost sources (v_job_cost_events.source):
--    trade_line      a trade app charge line (v_trade_charge_resolved), on the
--                    job it resolves to. Excluded: QA / delete test lines,
--                    ops-rejected trade invoices, and trade invoices whose Xero
--                    bill was DELETED or VOIDED.
--    supplier_bill   a line of a Xero bill (ACCPAY, AUTHORISED or PAID) linked
--                    to the job by xero_invoices.job_id. A bill that mirrors a
--                    trade app invoice is excluded here (the trade lines carry
--                    it): its id is a trade_invoices.xero_bill_id, or its lines
--                    carry the trade app's "<job> | SW - <division>" format.
--    materials_fact  an actual job_materials_facts row whose bill is not
--                    already counted on the same job as a supplier_bill, and is
--                    not a trade app mirror.
--    po_committed    an open purchase order with no bill yet. Committed, not
--                    actual: confidence 'committed', never in actual cost.
--    Lane of a supplier bill line: description naming commission ->
--    commission; account 306 (labour direct cost) -> labour; any other 3xx
--    cost-of-sales account -> materials; anything else -> other.
--
-- 2. One cost basis per job. Xero Project expense totals already include the
--    bills the bookkeeper put on the project, the trade app bills among them,
--    so a project total is NEVER added to line-level costs.
--      line_level             the job's line-level events (default).
--      xero_project_inferred  the job's project total is larger than everything
--                             line-level: labour, commission and other stay
--                             line-level and materials = project total minus
--                             those, flagged inferred.
--    When line-level labour, commission and other already exceed the project
--    total, the basis stays line_level and the job is flagged
--    project_below_trade_lines (the double-count check).
--
-- 3. Quoted ex GST takes a sent quote's value only from job_quote_values (the
--    one interpreter): the whole-job total when quotes are split by party,
--    else the accepted current quote, else the newest current quote; inc GST
--    divided by 1.1. With no sent quote value, pricing_json.totalExGST,
--    labelled as the live price.
--
-- 4. Expected cost by lane, first source that has it (expected_source):
--    jobs.expected_costs (frozen at acceptance) -> the accepted quote
--    revision's cost_estimates -> the newest sent quote revision's
--    cost_estimates -> pricing_json cost estimates (live price).
--
-- 5. Completeness reuses the job_financials vocabulary (revenue_flag
--    missing_client_invoice / ok; cost_flag no_labour_linked,
--    incomplete_invoice_lines, unclassified_lines, text_matched_lines, ok) and
--    adds no_cost_linked and cost_basis_inferred. Margin and profit are null
--    (suppressed) exactly where job_financials suppresses them: no client
--    invoice, no cost, incomplete trade invoice lines, or unclassified lines.
--
-- 6. Paid-verified means Xero recorded the payment (status PAID; trade
--    invoices paid). It is not a bank reconciliation.
--
-- job_financials, get_job_financials and their make-safe consumers are left
-- untouched. Nothing here writes.

CREATE OR REPLACE FUNCTION public.job_profit_num(p jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE jsonb_typeof(p)
           WHEN 'number' THEN (p #>> '{}')::numeric
           WHEN 'string' THEN CASE WHEN btrim(p #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$'
                                   THEN btrim(p #>> '{}')::numeric END
         END
$$;

COMMENT ON FUNCTION public.job_profit_num(jsonb) IS
  'Job profit engine (20261009130000): a JSON number or plain decimal string as numeric; anything else null, never 0.';

-- ─────────────────────────────────────────────────────────────
-- v_job_cost_events
-- ─────────────────────────────────────────────────────────────
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
po AS (
  SELECT
    p.job_id,
    COALESCE(p.delivery_date, p.created_at::date) AS event_date,
    'materials'::text AS lane,
    'purchase_order'::text AS lane_detail,
    'supplier'::text AS party_kind,
    COALESCE(NULLIF(btrim(p.supplier_name), ''), 'Unnamed supplier') AS party,
    COALESCE(p.subtotal, p.total / 1.1) AS amount_ex,
    'po_committed'::text AS source,
    p.id::text AS source_id,
    p.id::text AS document_id,
    p.po_number AS document_number,
    p.status AS document_status,
    false AS paid,
    NULL::date AS paid_on,
    'committed'::text AS confidence,
    false AS is_actual,
    p.notes AS description,
    NULL::numeric AS hours,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    'purchase_orders.job_id'::text AS match_method,
    false AS incomplete_invoice
  FROM public.purchase_orders p
  WHERE p.job_id IS NOT NULL
    AND p.xero_bill_id IS NULL
    AND p.invoice_received_at IS NULL
    AND lower(COALESCE(p.status, '')) NOT IN ('draft', 'billed', 'cancelled', 'canceled', 'void', 'voided', 'deleted')
    AND COALESCE(p.subtotal, p.total) IS NOT NULL
)
SELECT * FROM trade
UNION ALL SELECT * FROM supplier
UNION ALL SELECT * FROM fact
UNION ALL SELECT * FROM po;

COMMENT ON VIEW public.v_job_cost_events IS
  'Job profit engine (20261009130000): one row per job cost, lane labour/materials/commission/other, source trade_line/supplier_bill/materials_fact/po_committed. po_committed is committed, never actual (is_actual false). Read only, service role only.';

-- ─────────────────────────────────────────────────────────────
-- v_job_revenue_events
-- ─────────────────────────────────────────────────────────────
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
    LIMIT 1) AS business_unit
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
  NULL::text AS business_unit
FROM public.job_variations v
WHERE v.job_id IS NOT NULL;

COMMENT ON VIEW public.v_job_revenue_events IS
  'Job profit engine (20261009130000): sales invoice lines per job (VOIDED/DELETED excluded; counts_as_invoiced for AUTHORISED/PAID) and the job''s variations, listed only (counts_as_invoiced false). Read only, service role only.';

-- ─────────────────────────────────────────────────────────────
-- v_job_profit
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_job_profit AS
WITH rev AS (
  SELECT
    e.job_id,
    sum(e.amount_ex) FILTER (WHERE e.counts_as_invoiced) AS invoiced_ex,
    sum(e.amount_ex) FILTER (WHERE e.kind = 'invoice_line' AND e.status = 'DRAFT') AS draft_revenue_ex,
    sum(e.amount_ex) FILTER (WHERE e.kind = 'variation') AS variations_listed_ex,
    count(DISTINCT e.document_id) FILTER (WHERE e.counts_as_invoiced) AS invoice_count,
    bool_and(e.paid) FILTER (WHERE e.counts_as_invoiced) AS all_paid,
    max(e.paid_on) FILTER (WHERE e.counts_as_invoiced) AS last_paid_on,
    min(e.invoice_date) FILTER (WHERE e.counts_as_invoiced) AS first_invoice_date
  FROM public.v_job_revenue_events e
  GROUP BY e.job_id
),
collected AS (
  SELECT
    x.job_id,
    sum(CASE WHEN COALESCE(x.total, 0) <> 0 THEN x.amount_paid * x.sub_total / x.total ELSE x.amount_paid END) AS collected_ex
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCREC'
    AND x.job_id IS NOT NULL
    AND x.status IN ('AUTHORISED', 'PAID')
  GROUP BY x.job_id
),
cost AS (
  SELECT
    e.job_id,
    sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.lane = 'labour') AS labour_ex,
    sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.lane = 'materials') AS materials_ex,
    sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.lane = 'commission') AS commission_ex,
    sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.lane = 'other') AS other_ex,
    sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.source = 'trade_line') AS trade_lines_ex,
    sum(e.amount_ex) FILTER (WHERE NOT e.is_actual) AS committed_open_ex,
    count(*) FILTER (WHERE e.is_actual) AS actual_events,
    bool_and(e.paid) FILTER (WHERE e.is_actual) AS all_paid,
    bool_or(e.lane_detail = 'unclassified') AS has_unclassified,
    bool_or(e.source = 'trade_line' AND e.match_method <> 'job_id') AS has_text_matched,
    bool_or(e.incomplete_invoice) AS has_incomplete_invoice,
    bool_or(e.source = 'trade_line' AND e.document_status NOT IN ('approved', 'pushed_to_xero', 'paid')) AS has_unapproved_trade,
    min(e.event_date) FILTER (WHERE e.is_actual) AS first_cost_date,
    max(e.event_date) FILTER (WHERE e.is_actual) AS last_cost_date
  FROM public.v_job_cost_events e
  GROUP BY e.job_id
),
project AS (
  SELECT
    p.job_id,
    sum(p.total_expenses) AS project_expenses_ex,
    sum(p.total_invoiced) AS project_invoiced_ex,
    count(*) AS project_count
  FROM public.xero_projects p
  WHERE p.job_id IS NOT NULL
  GROUP BY p.job_id
),
accepted_rev AS (
  SELECT DISTINCT ON (r.job_id)
    r.job_id, r.id, r.internal_cost_snapshot_json -> 'cost_estimates' AS ce
  FROM public.quote_revisions r
  JOIN public.job_documents d ON d.id = r.job_document_id
  WHERE d.accepted_at IS NOT NULL
    AND jsonb_typeof(r.internal_cost_snapshot_json -> 'cost_estimates') = 'object'
  ORDER BY r.job_id, d.accepted_at DESC, r.version DESC
),
sent_rev AS (
  SELECT DISTINCT ON (r.job_id)
    r.job_id, r.id, r.internal_cost_snapshot_json -> 'cost_estimates' AS ce
  FROM public.quote_revisions r
  WHERE r.sent_at IS NOT NULL
    AND jsonb_typeof(r.internal_cost_snapshot_json -> 'cost_estimates') = 'object'
  ORDER BY r.job_id, r.sent_at DESC, r.version DESC
),
quote_docs AS (
  SELECT DISTINCT d.job_id
  FROM public.job_documents d
  WHERE d.type = 'quote' AND d.sent_at IS NOT NULL
),
quote_rows AS (
  SELECT
    q.job_id,
    v.value_inc_gst,
    v.value_source,
    v.whole_quote_total_inc,
    v.whole_quote_source,
    d.accepted_at,
    d.sent_at,
    d.created_at,
    d.superseded_at,
    d.declined_at
  FROM quote_docs q
  CROSS JOIN LATERAL public.job_quote_values(q.job_id) v
  JOIN public.job_documents d ON d.id = v.document_id
),
quote_pick AS (
  -- The commercial read's headline: the accepted current quote, else the
  -- newest current one (current = not superseded, not declined).
  SELECT DISTINCT ON (r.job_id)
    r.job_id,
    r.value_inc_gst,
    r.value_source,
    CASE WHEN r.accepted_at IS NOT NULL THEN 'accepted' ELSE 'newest_current' END AS basis
  FROM quote_rows r
  WHERE r.superseded_at IS NULL
    AND r.declined_at IS NULL
    AND r.value_inc_gst IS NOT NULL
  ORDER BY r.job_id, (r.accepted_at IS NOT NULL) DESC, r.accepted_at DESC NULLS LAST,
           r.sent_at DESC, r.created_at DESC
),
quote_whole AS (
  SELECT DISTINCT ON (r.job_id)
    r.job_id, r.whole_quote_total_inc, r.whole_quote_source
  FROM quote_rows r
  WHERE r.whole_quote_total_inc IS NOT NULL
  ORDER BY r.job_id
),
quoted AS (
  SELECT
    q.job_id,
    COALESCE(w.whole_quote_total_inc, p.value_inc_gst) AS quoted_inc,
    CASE
      WHEN w.whole_quote_total_inc IS NOT NULL THEN 'whole_job_total:' || w.whole_quote_source
      WHEN p.value_inc_gst IS NOT NULL THEN p.basis || ':' || p.value_source
    END AS quoted_source
  FROM quote_docs q
  LEFT JOIN quote_whole w ON w.job_id = q.job_id
  LEFT JOIN quote_pick p ON p.job_id = q.job_id
),
base AS (
  SELECT
    j.id AS job_id,
    j.org_id,
    j.job_number,
    j.client_name,
    j.type AS work_type,
    CASE
      WHEN j.type IN ('makesafe', 'repair', 'insurance')
        THEN COALESCE(NULLIF(j.metadata ->> 'ses_family', ''), NULLIF(j.metadata ->> 'makesafe_job_family', ''), md.report_type)
    END AS work_subtype,
    j.status,
    j.created_at,
    (lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) = 'true') AS holding_job,
    -- quoted
    CASE
      WHEN qd.quoted_inc IS NOT NULL THEN round(qd.quoted_inc / 1.1, 2)
      ELSE public.job_profit_num(j.pricing_json -> 'totalExGST')
    END AS quoted_ex,
    CASE
      WHEN qd.quoted_inc IS NOT NULL THEN 'sent_quote:' || qd.quoted_source
      WHEN public.job_profit_num(j.pricing_json -> 'totalExGST') IS NOT NULL THEN 'live_price_not_a_sent_quote'
    END AS quoted_source,
    -- expected by lane, first source that has it
    CASE
      WHEN jsonb_typeof(j.expected_costs -> 'lanes') = 'object' THEN 'frozen_at_acceptance'
      WHEN ar.job_id IS NOT NULL THEN 'accepted_quote_revision'
      WHEN sr.job_id IS NOT NULL THEN 'sent_quote_revision'
      WHEN COALESCE(public.job_profit_num(j.pricing_json -> 'totalCostEstimate'), 0) > 0 THEN 'live_pricing_estimate'
    END AS expected_source,
    CASE
      WHEN jsonb_typeof(j.expected_costs -> 'lanes') = 'object' THEN public.job_profit_num(j.expected_costs #> '{lanes,labour,amount_ex_gst}')
      WHEN ar.job_id IS NOT NULL THEN public.job_profit_num(ar.ce -> 'labour_total')
      WHEN sr.job_id IS NOT NULL THEN public.job_profit_num(sr.ce -> 'labour_total')
      WHEN COALESCE(public.job_profit_num(j.pricing_json -> 'totalCostEstimate'), 0) > 0 THEN public.job_profit_num(j.pricing_json -> 'labourCostEstimate')
    END AS expected_labour_ex,
    CASE
      WHEN jsonb_typeof(j.expected_costs -> 'lanes') = 'object' THEN public.job_profit_num(j.expected_costs #> '{lanes,materials,amount_ex_gst}')
      WHEN ar.job_id IS NOT NULL THEN public.job_profit_num(ar.ce -> 'material_total')
      WHEN sr.job_id IS NOT NULL THEN public.job_profit_num(sr.ce -> 'material_total')
      WHEN COALESCE(public.job_profit_num(j.pricing_json -> 'totalCostEstimate'), 0) > 0 THEN public.job_profit_num(j.pricing_json -> 'materialCostEstimate')
    END AS expected_materials_ex,
    CASE
      WHEN jsonb_typeof(j.expected_costs -> 'lanes') = 'object' THEN public.job_profit_num(j.expected_costs #> '{lanes,commission,amount_ex_gst}')
      WHEN ar.job_id IS NOT NULL THEN public.job_profit_num(ar.ce -> 'subcontract_commission_total')
      WHEN sr.job_id IS NOT NULL THEN public.job_profit_num(sr.ce -> 'subcontract_commission_total')
      WHEN COALESCE(public.job_profit_num(j.pricing_json -> 'totalCostEstimate'), 0) > 0 THEN public.job_profit_num(j.pricing_json -> 'commissionCostEstimate')
    END AS expected_commission_ex,
    -- revenue
    COALESCE(rev.invoiced_ex, 0) AS invoiced_ex,
    COALESCE(rev.draft_revenue_ex, 0) AS draft_revenue_ex,
    COALESCE(rev.variations_listed_ex, 0) AS variations_listed_ex,
    COALESCE(col.collected_ex, 0) AS collected_ex,
    COALESCE(rev.invoice_count, 0) AS invoice_count,
    rev.all_paid AS revenue_all_paid,
    rev.last_paid_on AS revenue_last_paid_on,
    rev.first_invoice_date,
    -- line-level costs
    COALESCE(cost.labour_ex, 0) AS line_labour_ex,
    COALESCE(cost.materials_ex, 0) AS line_materials_ex,
    COALESCE(cost.commission_ex, 0) AS line_commission_ex,
    COALESCE(cost.other_ex, 0) AS line_other_ex,
    COALESCE(cost.trade_lines_ex, 0) AS trade_lines_ex,
    COALESCE(cost.committed_open_ex, 0) AS committed_open_ex,
    COALESCE(cost.actual_events, 0) AS actual_cost_events,
    cost.all_paid AS cost_all_paid,
    COALESCE(cost.has_unclassified, false) AS has_unclassified,
    COALESCE(cost.has_text_matched, false) AS has_text_matched,
    COALESCE(cost.has_incomplete_invoice, false) AS has_incomplete_invoice,
    COALESCE(cost.has_unapproved_trade, false) AS has_unapproved_trade,
    cost.first_cost_date,
    cost.last_cost_date,
    -- Xero Projects, a separate reconciling figure
    pr.project_expenses_ex AS xero_project_expenses_ex,
    pr.project_invoiced_ex AS xero_project_invoiced_ex,
    COALESCE(pr.project_count, 0) AS xero_project_count
  FROM public.jobs j
  LEFT JOIN public.makesafe_job_details md ON md.job_id = j.id
  LEFT JOIN quoted qd ON qd.job_id = j.id
  LEFT JOIN accepted_rev ar ON ar.job_id = j.id
  LEFT JOIN sent_rev sr ON sr.job_id = j.id
  LEFT JOIN rev ON rev.job_id = j.id
  LEFT JOIN collected col ON col.job_id = j.id
  LEFT JOIN cost ON cost.job_id = j.id
  LEFT JOIN project pr ON pr.job_id = j.id
  WHERE j.legacy IS NOT TRUE
),
basis AS (
  SELECT
    b.*,
    b.line_labour_ex + b.line_materials_ex + b.line_commission_ex + b.line_other_ex AS line_total_ex,
    b.line_labour_ex + b.line_commission_ex + b.line_other_ex AS line_non_materials_ex,
    CASE
      WHEN COALESCE(b.xero_project_expenses_ex, 0) > 0
       AND b.line_labour_ex + b.line_materials_ex + b.line_commission_ex + b.line_other_ex
           < b.xero_project_expenses_ex - greatest(5, 0.01 * b.xero_project_expenses_ex)
       AND b.line_labour_ex + b.line_commission_ex + b.line_other_ex <= b.xero_project_expenses_ex
        THEN 'xero_project_inferred'
      ELSE 'line_level'
    END AS cost_basis,
    (COALESCE(b.xero_project_expenses_ex, 0) > 0
      AND b.line_labour_ex + b.line_commission_ex + b.line_other_ex
          > b.xero_project_expenses_ex + greatest(5, 0.01 * b.xero_project_expenses_ex)) AS project_below_trade_lines
  FROM base b
),
costed AS (
  SELECT
    s.*,
    s.line_labour_ex AS actual_labour_ex,
    CASE WHEN s.cost_basis = 'xero_project_inferred'
         THEN s.xero_project_expenses_ex - s.line_non_materials_ex
         ELSE s.line_materials_ex END AS actual_materials_ex,
    s.line_commission_ex AS actual_commission_ex,
    s.line_other_ex AS actual_other_ex,
    CASE WHEN s.cost_basis = 'xero_project_inferred'
         THEN s.xero_project_expenses_ex
         ELSE s.line_total_ex END AS actual_cost_ex,
    (s.actual_cost_events > 0 OR s.cost_basis = 'xero_project_inferred') AS has_cost
  FROM basis s
),
flagged AS (
  SELECT
    c.*,
    CASE WHEN c.invoiced_ex > 0 THEN 'ok' ELSE 'missing_client_invoice' END AS revenue_flag,
    CASE
      WHEN NOT c.has_cost THEN 'no_cost_linked'
      WHEN c.has_incomplete_invoice THEN 'incomplete_invoice_lines'
      WHEN c.has_unclassified THEN 'unclassified_lines'
      WHEN c.has_text_matched THEN 'text_matched_lines'
      WHEN c.cost_basis = 'xero_project_inferred' THEN 'cost_basis_inferred'
      WHEN c.actual_labour_ex = 0 THEN 'no_labour_linked'
      ELSE 'ok'
    END AS cost_flag,
    (c.invoiced_ex > 0 AND c.has_cost AND NOT c.has_incomplete_invoice AND NOT c.has_unclassified) AS margin_ok
  FROM costed c
)
SELECT
  f.job_id,
  f.org_id,
  f.job_number,
  f.client_name,
  f.work_type,
  f.work_subtype,
  f.status,
  f.created_at,
  f.quoted_ex,
  f.quoted_source,
  f.expected_source,
  f.expected_labour_ex,
  f.expected_materials_ex,
  f.expected_commission_ex,
  CASE WHEN f.expected_source IS NOT NULL
       THEN COALESCE(f.expected_labour_ex, 0) + COALESCE(f.expected_materials_ex, 0) + COALESCE(f.expected_commission_ex, 0)
  END AS expected_cost_ex,
  f.cost_basis,
  f.actual_labour_ex,
  f.actual_materials_ex,
  f.actual_commission_ex,
  f.actual_other_ex,
  f.actual_cost_ex,
  (f.cost_basis = 'xero_project_inferred') AS materials_inferred,
  f.line_total_ex AS line_level_cost_ex,
  f.trade_lines_ex,
  f.committed_open_ex,
  f.xero_project_expenses_ex,
  f.xero_project_invoiced_ex,
  f.xero_project_count,
  f.invoiced_ex,
  f.draft_revenue_ex,
  f.variations_listed_ex,
  f.collected_ex,
  f.invoice_count,
  CASE WHEN f.margin_ok THEN f.invoiced_ex - f.actual_cost_ex END AS profit_ex,
  CASE WHEN f.margin_ok THEN round((f.invoiced_ex - f.actual_cost_ex) / f.invoiced_ex * 100, 1) END AS margin_pct,
  f.invoiced_ex - f.actual_cost_ex AS profit_ex_unsuppressed,
  (f.invoice_count > 0 AND COALESCE(f.revenue_all_paid, false)) AS revenue_verified_paid,
  (f.cost_basis = 'line_level' AND f.actual_cost_events > 0 AND COALESCE(f.cost_all_paid, false)) AS costs_verified_paid,
  f.revenue_last_paid_on,
  f.first_invoice_date,
  f.first_cost_date,
  f.last_cost_date,
  f.revenue_flag,
  f.cost_flag,
  array_remove(ARRAY[
    CASE WHEN f.revenue_flag <> 'ok' THEN f.revenue_flag END,
    CASE WHEN NOT f.has_cost THEN 'no_cost_linked' END,
    CASE WHEN f.has_incomplete_invoice THEN 'incomplete_invoice_lines' END,
    CASE WHEN f.has_unclassified THEN 'unclassified_lines' END,
    CASE WHEN f.has_text_matched THEN 'text_matched_lines' END,
    CASE WHEN f.cost_basis = 'xero_project_inferred' THEN 'cost_basis_inferred' END,
    CASE WHEN f.has_cost AND f.actual_labour_ex = 0 THEN 'no_labour_linked' END,
    CASE WHEN f.project_below_trade_lines THEN 'project_below_trade_lines' END,
    CASE WHEN f.cost_basis = 'line_level' AND f.has_cost AND f.actual_materials_ex = 0
              AND f.work_type IN ('fencing', 'patio', 'decking', 'combo') THEN 'materials_not_linked' END,
    CASE WHEN f.has_unapproved_trade THEN 'unapproved_trade_charges' END,
    CASE WHEN f.committed_open_ex > 0 THEN 'open_purchase_orders' END,
    CASE WHEN f.draft_revenue_ex > 0 THEN 'draft_revenue' END,
    CASE WHEN f.holding_job THEN 'holding_job' END
  ], NULL) AS completeness,
  f.margin_ok,
  f.holding_job
FROM flagged f;

COMMENT ON VIEW public.v_job_profit IS
  'Job profit engine (20261009130000): one row per non-legacy job, all types. Gross profit on direct costs, no overhead. One cost basis per job (line_level, or xero_project_inferred with materials = project total minus line-level labour, commission and other). Margin/profit null where job_financials would suppress them. Read only, service role only.';

-- ─────────────────────────────────────────────────────────────
-- job_profit(job_id)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.job_profit(p_job_id uuid)
RETURNS SETOF public.v_job_profit
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT * FROM public.v_job_profit WHERE job_id = p_job_id
$$;

COMMENT ON FUNCTION public.job_profit(uuid) IS
  'Job profit engine (20261009130000): v_job_profit for one job. Read only, service role only.';

-- Money reads: service role only. Views run with their owner's rights, so the
-- revoke is what keeps them off the anon and signed-in API.
REVOKE ALL ON public.v_job_cost_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_job_revenue_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_job_profit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_job_cost_events TO service_role;
GRANT SELECT ON public.v_job_revenue_events TO service_role;
GRANT SELECT ON public.v_job_profit TO service_role;

REVOKE ALL ON FUNCTION public.job_profit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_profit_num(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_profit_num(jsonb) TO service_role;
