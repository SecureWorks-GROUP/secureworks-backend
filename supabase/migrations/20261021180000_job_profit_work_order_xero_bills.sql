-- Job profit: append four columns onto the CFO view (20261020220000).
--
-- Stacked on 20261020220000_job_profit_quote_costs_incomplete (PR #1121,
-- fm/cfo-quote-costs-incomplete-20261020, including its JP-12 restore).
-- This file replaces v_job_profit: JP-12 installer-bill blanking and every
-- #1121 column stay, then margin_source, margin_cost_ex,
-- expected_labour_quote_ex and work_order_agreed_labour_ex are appended.
-- It adds the switches below. Apply only after 20261020220000. The live
-- migration ledger was not read when 20261021180000 was chosen (not observed).
--
-- DEFAULT, owner to confirm. Three switches, all seeded OFF. While one of
-- those switches is off, missing or unreadable, the columns that switch owns
-- stay what 20261020220000 published. An unconfirmed installer bill is not
-- behind a switch: JP-12 always flags installer_bill_unconfirmed, blanks
-- profit and margin, and keeps that amount out of actual cost, so a flags-off
-- completeness list is 20261020220000's list plus that flag when such a bill
-- is on the job. The four new columns are evidence only until their switch
-- is on.
--
--   job_profit_work_order_labour_v1
--     expected labour is an APPROVED job work order only (status approved
--     and approved_at is not null), plus approved customer-variation trade
--     allocation, ahead of the quote snapshot. A draft is ignored. Crew
--     work orders are not read. A stored 0 is a real figure.
--   job_profit_xero_project_cost_v1
--     the Xero Project figure replaces the linked cost only when the job is
--     finished (complete, completed, invoiced, archived, get_review,
--     final_payment) or billed labour has reached an approved work order
--     whose agreed labour is above zero, and a client invoice exists, and
--     lines are complete and classified, and no installer bill is still
--     unconfirmed. A stored agreed labour of 0 is a real expected-labour
--     figure and does not publish this margin. margin_source is exactly
--     'from Xero Project, may exclude unlinked labour'. Otherwise the margin
--     stays blank and xero_project_exceeds_line_costs stays set, with
--     xero_project_margin_held. When the project margin publishes, that
--     suppressor is not set and cost_flag is ok. actual_cost_ex stays the
--     linked lines. An unconfirmed installer bill still blanks the margin.
--   job_profit_patio_quote_v1
--     a patio sales price is one frozen quote, and only when that figure is
--     the only candidate and it agrees with the live price and with what has
--     been invoiced. A conflict is blank and flagged. The live price is never
--     published. jobs.quoted_value is never read.
--
-- This migration does not write bill proposals and does not install a
-- token function. Supplier bills are linked by job number through xero-sync
-- bill prematch, which is the only writer of Bills to place
-- (materials_bill_proposals). There is no second writer and no second
-- queue table.
--
-- Nothing here updates a job, a quote, a work order, or a bill.

CREATE OR REPLACE FUNCTION public.job_profit_flag_on(p_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v boolean;
BEGIN
  SELECT bool_and(enabled) INTO v
    FROM public.feature_flags
   WHERE flag_name = p_name;
  RETURN COALESCE(v, false);
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$fn$;

COMMENT ON FUNCTION public.job_profit_flag_on(text) IS
  'Job profit switches (20261021180000). True only when that feature_flags row exists and is enabled. Missing, unreadable or any error is off.';

CREATE OR REPLACE FUNCTION public.job_profit_patio_rule3_statuses()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT ARRAY[
    'accepted', 'partially_accepted', 'approvals', 'deposit', 'awaiting_deposit',
    'processing', 'order_materials', 'awaiting_supplier', 'order_confirmed',
    'schedule_install', 'scheduled', 'in_progress', 'rectification',
    'complete', 'invoiced', 'archived', 'get_review', 'final_payment'
  ]::text[]
$fn$;

COMMENT ON FUNCTION public.job_profit_patio_rule3_statuses() IS
  'Statuses in which a patio job may use its frozen tool quote. Quoted and draft are not in this list.';

CREATE OR REPLACE FUNCTION public.job_profit_patio_ex(p_text text)
RETURNS TABLE (quoted_ex numeric, note text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  j jsonb;
  ex numeric;
  inc numeric;
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN QUERY SELECT NULL::numeric, 'unreadable'::text;
    RETURN;
  END IF;
  BEGIN
    j := p_text::jsonb;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN QUERY SELECT NULL::numeric, 'unreadable'::text;
      RETURN;
  END;
  IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR j = '{}'::jsonb THEN
    RETURN QUERY SELECT NULL::numeric, 'unreadable'::text;
    RETURN;
  END IF;
  ex := public.job_profit_num(j -> 'totalExGST');
  inc := public.job_profit_num(j -> 'totalIncGST');
  IF ex IS NOT NULL AND inc IS NOT NULL
     AND abs(ex - round(inc / 1.1, 2)) > 0.05 THEN
    RETURN QUERY SELECT NULL::numeric, 'ex_inc_conflict'::text;
    RETURN;
  END IF;
  IF ex IS NOT NULL THEN
    RETURN QUERY SELECT round(ex, 2), NULL::text;
    RETURN;
  END IF;
  IF inc IS NOT NULL THEN
    RETURN QUERY SELECT round(inc / 1.1, 2), NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT NULL::numeric, 'unreadable'::text;
END;
$fn$;

COMMENT ON FUNCTION public.job_profit_patio_ex(text) IS
  'Patio tool quote ex GST from pricing text (totalExGST, else totalIncGST / 1.1). unreadable or ex_inc_conflict returns no figure. Never reads jobs.quoted_value.';

CREATE OR REPLACE FUNCTION public.job_profit_patio_quote(
  p_job_id uuid,
  p_work_type text,
  p_status text,
  p_sent_quoted_ex numeric,
  p_invoiced_ex numeric,
  p_pricing_json jsonb,
  p_enabled boolean
)
RETURNS TABLE (quoted_ex numeric, note text, source text)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_n int;
  v_bad int;
  v_good int;
  v_lo numeric;
  v_hi numeric;
  v_frozen numeric;
  v_live_ex numeric;
  v_live_inc numeric;
  v_live numeric;
  v_live_bad boolean;
  v_live_present boolean;
BEGIN
  IF NOT COALESCE(p_enabled, false) THEN
    RETURN;
  END IF;
  IF p_work_type IS DISTINCT FROM 'patio' THEN
    RETURN;
  END IF;
  IF NOT (lower(COALESCE(p_status, '')) = ANY (public.job_profit_patio_rule3_statuses())) THEN
    RETURN;
  END IF;

  v_live_ex := public.job_profit_num(p_pricing_json -> 'totalExGST');
  v_live_inc := public.job_profit_num(p_pricing_json -> 'totalIncGST');
  v_live_bad := v_live_ex IS NOT NULL AND v_live_inc IS NOT NULL
    AND abs(v_live_ex - round(v_live_inc / 1.1, 2)) > 0.05;
  v_live_present := v_live_ex IS NOT NULL OR v_live_inc IS NOT NULL;
  IF v_live_bad THEN
    v_live := NULL;
  ELSIF v_live_ex IS NOT NULL THEN
    v_live := round(v_live_ex, 2);
  ELSIF v_live_inc IS NOT NULL THEN
    v_live := round(v_live_inc / 1.1, 2);
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE px.note IS DISTINCT FROM NULL AND px.quoted_ex IS NULL),
         count(*) FILTER (WHERE px.note IS NULL AND px.quoted_ex IS NOT NULL),
         min(px.quoted_ex) FILTER (WHERE px.note IS NULL),
         max(px.quoted_ex) FILTER (WHERE px.note IS NULL)
    INTO v_n, v_bad, v_good, v_lo, v_hi
  FROM public.scope_revisions sr
  CROSS JOIN LATERAL public.job_profit_patio_ex(sr.pricing_canonical_text) px
  WHERE sr.job_id = p_job_id
    AND sr.status = 'frozen'
    AND sr.superseded_at IS NULL;

  IF COALESCE(v_n, 0) = 0 THEN
    IF v_live_present AND NOT v_live_bad THEN
      RETURN QUERY SELECT NULL::numeric, 'patio_sales_price_live_only'::text, NULL::text;
    END IF;
    RETURN;
  END IF;

  IF COALESCE(v_bad, 0) > 0 AND COALESCE(v_good, 0) > 0 THEN
    RETURN QUERY SELECT NULL::numeric, 'patio_sales_price_conflict'::text, NULL::text;
    RETURN;
  END IF;
  IF COALESCE(v_good, 0) = 0 THEN
    RETURN QUERY SELECT NULL::numeric, 'patio_sales_price_unreadable'::text, NULL::text;
    RETURN;
  END IF;
  IF v_hi - v_lo > 1 THEN
    RETURN QUERY SELECT NULL::numeric, 'patio_sales_price_conflict'::text, NULL::text;
    RETURN;
  END IF;

  SELECT px.quoted_ex INTO v_frozen
  FROM public.scope_revisions sr
  CROSS JOIN LATERAL public.job_profit_patio_ex(sr.pricing_canonical_text) px
  WHERE sr.job_id = p_job_id
    AND sr.status = 'frozen'
    AND sr.superseded_at IS NULL
    AND px.note IS NULL
    AND px.quoted_ex IS NOT NULL
  ORDER BY sr.frozen_at DESC NULLS LAST, sr.revision_number DESC
  LIMIT 1;

  IF v_live_bad THEN
    RETURN QUERY SELECT NULL::numeric, 'ex_inc_conflict'::text, NULL::text;
    RETURN;
  END IF;
  IF v_live_present AND abs(v_live - v_frozen) > 1 THEN
    RETURN QUERY SELECT NULL::numeric, 'patio_sales_price_conflict'::text, NULL::text;
    RETURN;
  END IF;
  IF COALESCE(p_invoiced_ex, 0) > v_frozen + 1 THEN
    RETURN QUERY SELECT NULL::numeric, 'patio_sales_price_conflict'::text, NULL::text;
    RETURN;
  END IF;
  IF p_sent_quoted_ex IS NOT NULL AND abs(p_sent_quoted_ex - v_frozen) > 1 THEN
    RETURN QUERY SELECT NULL::numeric, 'patio_sales_price_conflict'::text, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_frozen, NULL::text, 'sole_frozen_revision'::text;
END;
$fn$;

COMMENT ON FUNCTION public.job_profit_patio_quote(uuid, text, text, numeric, numeric, jsonb, boolean) IS
  'Patio sales price (20261021180000). Off, or not a patio, returns no row so the sent quote stands. One agreeing frozen quote is published only when it is consistent with the live price and with invoiced-to-date. A conflict returns no figure. Never reads jobs.quoted_value.';

REVOKE ALL ON FUNCTION public.job_profit_flag_on(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_profit_patio_rule3_statuses() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_profit_patio_ex(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_profit_patio_quote(uuid, text, text, numeric, numeric, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_flag_on(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_profit_patio_rule3_statuses() TO service_role;
GRANT EXECUTE ON FUNCTION public.job_profit_patio_ex(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_profit_patio_quote(uuid, text, text, numeric, numeric, jsonb, boolean) TO service_role;

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'job_profit_work_order_labour_v1',
  false,
  $d$DEFAULT, owner to confirm. Job profit expected labour. When on, only an approved job work order (approved_at not null, plus approved customer-variation trade allocation) is expected labour, ahead of the quote snapshot. A draft is ignored. Off, missing or unreadable: expected labour stays the quote snapshot. Turn on only on the owner's word.$d$
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_work_order_labour_v1'
);

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'job_profit_xero_project_cost_v1',
  false,
  $d$DEFAULT, owner to confirm. Job profit Xero Project cost. When on, the project figure is the published cost only when the job is finished or billed labour has reached an approved work order whose agreed labour is above zero, and margin_source is exactly "from Xero Project, may exclude unlinked labour". A stored agreed labour of 0 does not publish it. Otherwise the margin stays blank. Off, missing or unreadable: a project that exceeds the linked lines still nulls profit. Do not turn on before the profit page shows that label. Turn on only on the owner's word.$d$
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_xero_project_cost_v1'
);

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'job_profit_patio_quote_v1',
  false,
  $d$DEFAULT, owner to confirm. Job profit patio sales price. When on, a patio job's quoted figure is its one frozen tool quote when that figure agrees with the live price and with invoiced-to-date. A conflict is blank and flagged. The live price is never published. Off, missing or unreadable: quoted_ex stays the sent quote only. Turn on only on the owner's word.$d$
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_patio_quote_v1'
);

CREATE OR REPLACE VIEW public.v_job_profit AS
WITH rev AS (
  SELECT
    e.job_id,
    sum(e.amount_ex) FILTER (WHERE e.counts_as_invoiced) AS invoiced_ex,
    sum(e.amount_ex) FILTER (WHERE e.kind = 'invoice_line' AND e.status = 'DRAFT') AS draft_revenue_ex,
    sum(e.amount_ex) FILTER (WHERE e.kind = 'variation' AND e.agreed) AS variations_listed_ex,
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
    sum(e.amount_ex) FILTER (WHERE e.source = 'po_committed') AS committed_open_ex,
    count(*) FILTER (WHERE e.source = 'po_ordered') AS ordered_not_billed_count,
    count(*) FILTER (WHERE e.source = 'po_ordered'
                     AND e.event_date <= (now() AT TIME ZONE 'Australia/Perth')::date - 30) AS ordered_not_billed_over_30_count,
    count(*) FILTER (WHERE e.source = 'po_invoice_emailed') AS invoice_emailed_count,
    sum(e.amount_ex) FILTER (WHERE e.source = 'po_invoice_emailed') AS invoice_emailed_ex,
    count(*) FILTER (WHERE e.is_actual) AS actual_events,
    bool_and(e.paid) FILTER (WHERE e.is_actual AND e.amount_ex <> 0) AS all_paid,
    bool_or(e.lane_detail = 'unclassified') AS has_unclassified,
    bool_or(e.source = 'trade_line' AND e.match_method <> 'job_id') AS has_text_matched,
    bool_or(e.incomplete_invoice) AS has_incomplete_invoice,
    bool_or(e.source = 'installer_bill_unconfirmed') AS has_installer_unconfirmed,
    bool_or(e.source = 'trade_line' AND e.amount_ex <> 0
            AND e.document_status NOT IN ('approved', 'pushed_to_xero', 'paid')) AS has_unapproved_trade,
    min(e.event_date) FILTER (WHERE e.is_actual) AS first_cost_date,
    max(e.event_date) FILTER (WHERE e.is_actual) AS last_cost_date
  FROM public.v_job_cost_events e
  GROUP BY e.job_id
),
project AS (
  SELECT
    p.job_id,
    sum(p.total_expenses) FILTER (WHERE named.own) AS project_expenses_ex,
    sum(p.total_invoiced) FILTER (WHERE named.own) AS project_invoiced_ex,
    count(*) FILTER (WHERE named.own) AS project_count,
    bool_or(NOT named.own) AS contact_only
  FROM public.xero_projects p
  JOIN public.jobs pj ON pj.id = p.job_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      btrim(pj.job_number) <> ''
      AND upper(p.project_name) ~ (
        regexp_replace(upper(btrim(pj.job_number)), '([^A-Z0-9])', '\\\1', 'g') || '(?![0-9])'
      ),
      false
    ) AS own
  ) named
  GROUP BY p.job_id
),
accepted_rev AS (
  SELECT n.job_id, n.ce
  FROM (
    SELECT DISTINCT ON (r.job_id)
      r.job_id, r.internal_cost_snapshot_json -> 'cost_estimates' AS ce
    FROM public.quote_revisions r
    JOIN public.job_documents d ON d.id = r.job_document_id
    WHERE d.accepted_at IS NOT NULL
    ORDER BY r.job_id, d.accepted_at DESC, r.version DESC
  ) n
  WHERE greatest(
          COALESCE(public.job_profit_num(n.ce -> 'labour_total'), 0),
          COALESCE(public.job_profit_num(n.ce -> 'material_total'), 0),
          COALESCE(public.job_profit_num(n.ce -> 'subcontract_commission_total'), 0)
        ) > 0
),
sent_rev AS (
  SELECT n.job_id, n.ce
  FROM (
    SELECT DISTINCT ON (r.job_id)
      r.job_id, r.internal_cost_snapshot_json -> 'cost_estimates' AS ce
    FROM public.quote_revisions r
    WHERE r.sent_at IS NOT NULL
    ORDER BY r.job_id, r.sent_at DESC, r.version DESC
  ) n
  WHERE greatest(
          COALESCE(public.job_profit_num(n.ce -> 'labour_total'), 0),
          COALESCE(public.job_profit_num(n.ce -> 'material_total'), 0),
          COALESCE(public.job_profit_num(n.ce -> 'subcontract_commission_total'), 0)
        ) > 0
),
quote_costs_open AS (
  -- The revision the job's quote stands on, picked exactly as accepted_rev and
  -- sent_rev pick theirs (same filters, same order) but before their costed
  -- filter: the newest accepted revision if the job has one, else the newest
  -- sent. The job is named incomplete when that revision's sealed cost
  -- estimates say a cost is still to confirm (costs_complete false, sealed
  -- since 20 Oct 2026 by the fence seal). Read only to name the job
  -- incomplete; it never supplies a figure.
  SELECT COALESCE(a.job_id, s.job_id) AS job_id
  FROM (
    SELECT DISTINCT ON (r.job_id)
      r.job_id, r.internal_cost_snapshot_json -> 'cost_estimates' AS ce
    FROM public.quote_revisions r
    JOIN public.job_documents d ON d.id = r.job_document_id
    WHERE d.accepted_at IS NOT NULL
    ORDER BY r.job_id, d.accepted_at DESC, r.version DESC
  ) a
  FULL JOIN (
    SELECT DISTINCT ON (r.job_id)
      r.job_id, r.internal_cost_snapshot_json -> 'cost_estimates' AS ce
    FROM public.quote_revisions r
    WHERE r.sent_at IS NOT NULL
    ORDER BY r.job_id, r.sent_at DESC, r.version DESC
  ) s ON s.job_id = a.job_id
  WHERE (CASE WHEN a.job_id IS NOT NULL THEN a.ce ELSE s.ce END) ->> 'costs_complete' = 'false'
),
quote_docs AS (
  SELECT DISTINCT d.job_id
  FROM public.job_documents d
  WHERE d.type = 'quote' AND d.sent_at IS NOT NULL
),
-- Keep this CTE single-use. Splitting whole quote and picked quote into
-- separate consumers materializes the rows and runs job_quote_values for
-- every quoted job, even when a caller filters v_job_profit to one job.
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
    d.declined_at,
    row_number() OVER (
      PARTITION BY q.job_id
      ORDER BY
        (d.superseded_at IS NULL AND d.declined_at IS NULL AND v.value_inc_gst IS NOT NULL) DESC,
        (d.accepted_at IS NOT NULL) DESC,
        d.accepted_at DESC NULLS LAST,
        d.sent_at DESC,
        d.created_at DESC
    ) AS pick_rank
  FROM quote_docs q
  CROSS JOIN LATERAL public.job_quote_values(q.job_id) v
  JOIN public.job_documents d ON d.id = v.document_id
),
quoted AS (
  SELECT
    q.job_id,
    COALESCE(q.whole_quote_total_inc, q.picked_value_inc_gst) AS quoted_inc,
    CASE
      WHEN q.whole_quote_total_inc IS NOT NULL THEN 'whole_job_total:' || q.whole_quote_source
      WHEN q.picked_value_inc_gst IS NOT NULL THEN q.picked_basis || ':' || q.picked_value_source
    END AS quoted_source
  FROM (
    SELECT
      r.job_id,
      max(r.whole_quote_total_inc) AS whole_quote_total_inc,
      max(r.whole_quote_source) FILTER (WHERE r.whole_quote_total_inc IS NOT NULL) AS whole_quote_source,
      max(r.value_inc_gst) FILTER (
        WHERE r.pick_rank = 1
          AND r.superseded_at IS NULL
          AND r.declined_at IS NULL
          AND r.value_inc_gst IS NOT NULL
      ) AS picked_value_inc_gst,
      max(r.value_source) FILTER (
        WHERE r.pick_rank = 1
          AND r.superseded_at IS NULL
          AND r.declined_at IS NULL
          AND r.value_inc_gst IS NOT NULL
      ) AS picked_value_source,
      CASE WHEN bool_or(r.accepted_at IS NOT NULL) FILTER (
        WHERE r.pick_rank = 1
          AND r.superseded_at IS NULL
          AND r.declined_at IS NULL
          AND r.value_inc_gst IS NOT NULL
      ) THEN 'accepted' ELSE 'newest_current' END AS picked_basis
    FROM quote_rows r
    GROUP BY r.job_id
  ) q
),
base AS (
  SELECT
    j.id AS job_id,
    j.org_id,
    j.job_number,
    j.client_name,
    CASE
      WHEN j.type = 'repair' OR fam.family = 'repair' THEN 'repair'
      ELSE j.type
    END AS work_type,
    fam.family AS work_subtype,
    j.status,
    j.created_at,
    (lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) = 'true') AS holding_job,
    -- quoted
    round(qd.quoted_inc / 1.1, 2) AS quoted_ex,
    'sent_quote:' || qd.quoted_source AS quoted_source,
    -- expected by lane, first quote-fixed source that has it
    CASE
      WHEN jsonb_typeof(j.expected_costs -> 'lanes') = 'object' THEN 'frozen_at_acceptance'
      WHEN ar.job_id IS NOT NULL THEN 'accepted_quote_revision'
      WHEN sr.job_id IS NOT NULL THEN 'sent_quote_revision'
    END AS expected_source,
    CASE
      WHEN jsonb_typeof(j.expected_costs -> 'lanes') = 'object' THEN public.job_profit_num(j.expected_costs #> '{lanes,labour,amount_ex_gst}')
      WHEN ar.job_id IS NOT NULL THEN public.job_profit_num(ar.ce -> 'labour_total')
      WHEN sr.job_id IS NOT NULL THEN public.job_profit_num(sr.ce -> 'labour_total')
    END AS expected_labour_ex,
    CASE
      WHEN jsonb_typeof(j.expected_costs -> 'lanes') = 'object' THEN public.job_profit_num(j.expected_costs #> '{lanes,materials,amount_ex_gst}')
      WHEN ar.job_id IS NOT NULL THEN public.job_profit_num(ar.ce -> 'material_total')
      WHEN sr.job_id IS NOT NULL THEN public.job_profit_num(sr.ce -> 'material_total')
    END AS expected_materials_ex,
    CASE
      WHEN jsonb_typeof(j.expected_costs -> 'lanes') = 'object' THEN public.job_profit_num(j.expected_costs #> '{lanes,commission,amount_ex_gst}')
      WHEN ar.job_id IS NOT NULL THEN public.job_profit_num(ar.ce -> 'subcontract_commission_total')
      WHEN sr.job_id IS NOT NULL THEN public.job_profit_num(sr.ce -> 'subcontract_commission_total')
    END AS expected_commission_ex,
    -- read only to decide whether materials are owed; never returned
    public.job_profit_num(j.pricing_json -> 'materialCostEstimate') AS live_materials_estimate_ex,
    -- no expected cost is fixed because the quote's costs are not all known
    (jsonb_typeof(j.expected_costs -> 'lanes') IS DISTINCT FROM 'object'
      AND ar.job_id IS NULL AND sr.job_id IS NULL
      AND qco.job_id IS NOT NULL) AS quote_costs_incomplete,
    j.pricing_json AS pricing_json,
    wo_agreed.agreed_labour_ex AS work_order_agreed_labour_ex,
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
    COALESCE(cost.ordered_not_billed_count, 0) AS ordered_not_billed_count,
    COALESCE(cost.ordered_not_billed_over_30_count, 0) AS ordered_not_billed_over_30_count,
    COALESCE(cost.invoice_emailed_count, 0) AS invoice_emailed_count,
    cost.invoice_emailed_ex,
    COALESCE(cost.actual_events, 0) AS actual_cost_events,
    cost.all_paid AS cost_all_paid,
    COALESCE(cost.has_unclassified, false) AS has_unclassified,
    COALESCE(cost.has_text_matched, false) AS has_text_matched,
    COALESCE(cost.has_incomplete_invoice, false) AS has_incomplete_invoice,
    COALESCE(cost.has_installer_unconfirmed, false) AS has_installer_unconfirmed,
    COALESCE(cost.has_unapproved_trade, false) AS has_unapproved_trade,
    cost.first_cost_date,
    cost.last_cost_date,
    -- Xero Projects: expenses on record, evidence only, never a cost
    pr.project_expenses_ex AS xero_project_expenses_ex,
    pr.project_invoiced_ex AS xero_project_invoiced_ex,
    COALESCE(pr.project_count, 0) AS xero_project_count,
    COALESCE(pr.contact_only, false) AS project_contact_only
  FROM public.jobs j
  LEFT JOIN public.makesafe_job_details md ON md.job_id = j.id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN lower(COALESCE(j.metadata ->> 'insurance_job_type', '')) = 'restoration' THEN 'restoration'
      ELSE lower(COALESCE(NULLIF(btrim(j.metadata ->> 'ses_family'), ''),
                          NULLIF(btrim(j.metadata ->> 'makesafe_job_family'), ''),
                          NULLIF(btrim(md.report_type), '')))
    END AS family
  ) fam
  LEFT JOIN quoted qd ON qd.job_id = j.id
  LEFT JOIN accepted_rev ar ON ar.job_id = j.id
  LEFT JOIN sent_rev sr ON sr.job_id = j.id
  LEFT JOIN quote_costs_open qco ON qco.job_id = j.id
  LEFT JOIN LATERAL (
    SELECT
      wo.agreed_labour_ex
        + COALESCE((
            SELECT sum(v.trade_allocation_ex)
              FROM public.work_order_customer_variations v
             WHERE v.work_order_id = wo.id
               AND v.status = 'approved'
               AND v.approved_at IS NOT NULL
          ), 0) AS agreed_labour_ex
    FROM public.work_orders wo
    WHERE wo.job_id = j.id
      AND wo.kind = 'job'
      AND wo.status = 'approved'
      AND wo.approved_at IS NOT NULL
      AND wo.agreed_labour_ex IS NOT NULL
    ORDER BY wo.approved_at DESC NULLS LAST, wo.id
    LIMIT 1
  ) wo_agreed ON true
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
    (COALESCE(b.xero_project_expenses_ex, 0) > 0
      AND b.line_labour_ex + b.line_materials_ex + b.line_commission_ex + b.line_other_ex
          < b.xero_project_expenses_ex - greatest(5, 0.01 * b.xero_project_expenses_ex)) AS project_exceeds_line_costs
  FROM base b
),
costed AS (
  SELECT
    s.*,
    -- Materials are owed but none is known: a fencing, patio, decking or combo
    -- job, or any job whose expected cost (or, with no fixed expected cost,
    -- live pricing estimate) carries materials, with no positive materials
    -- line. Its margin would be labour-only, so it is suppressed rather than
    -- published high.
    (s.line_materials_ex <= 0
      AND (s.work_type IN ('fencing', 'patio', 'decking', 'combo')
           OR COALESCE(s.expected_materials_ex, 0) > 0
           OR (s.expected_source IS NULL AND COALESCE(s.live_materials_estimate_ex, 0) > 0))) AS materials_missing,
    (s.line_labour_ex = 0) AS labour_missing,
    s.line_labour_ex AS actual_labour_ex,
    s.line_materials_ex AS actual_materials_ex,
    s.line_commission_ex AS actual_commission_ex,
    s.line_other_ex AS actual_other_ex,
    s.line_total_ex AS actual_cost_ex,
    (s.actual_cost_events > 0) AS has_cost
  FROM basis s
),
flagged AS (
  SELECT
    c.*,
    CASE WHEN c.invoiced_ex > 0 THEN 'ok' ELSE 'missing_client_invoice' END AS revenue_flag,
    CASE
      WHEN c.project_exceeds_line_costs THEN 'xero_project_exceeds_line_costs'
      WHEN c.has_installer_unconfirmed THEN 'installer_bill_unconfirmed'
      WHEN NOT c.has_cost THEN 'no_cost_linked'
      WHEN c.has_incomplete_invoice THEN 'incomplete_invoice_lines'
      WHEN c.has_unclassified THEN 'unclassified_lines'
      WHEN c.materials_missing THEN 'materials_not_linked'
      WHEN c.labour_missing THEN 'no_labour_linked'
      WHEN c.has_text_matched THEN 'text_matched_lines'
      ELSE 'ok'
    END AS cost_flag,
    (c.invoiced_ex > 0 AND c.has_cost AND NOT c.has_incomplete_invoice AND NOT c.has_unclassified
      AND NOT c.project_exceeds_line_costs
      AND NOT c.has_installer_unconfirmed
      AND NOT c.materials_missing AND NOT c.labour_missing) AS margin_ok
  FROM costed c
),
flags AS MATERIALIZED (
  SELECT
    public.job_profit_flag_on('job_profit_work_order_labour_v1') AS wo_labour,
    public.job_profit_flag_on('job_profit_xero_project_cost_v1') AS xero_project,
    public.job_profit_flag_on('job_profit_patio_quote_v1') AS patio
),
shown AS (
  SELECT
    f.*,
    fl.wo_labour,
    fl.xero_project,
    fl.patio,
    CASE
      WHEN fl.wo_labour AND f.work_order_agreed_labour_ex IS NOT NULL THEN f.work_order_agreed_labour_ex
      ELSE f.expected_labour_ex
    END AS shown_labour_ex,
    CASE
      WHEN fl.wo_labour AND f.work_order_agreed_labour_ex IS NOT NULL THEN 'job_work_order'
      ELSE f.expected_source
    END AS shown_expected_source,
    pq.quoted_ex AS patio_quoted_ex,
    pq.note AS patio_note,
    pq.source AS patio_source
  FROM flagged f
  CROSS JOIN flags fl
  LEFT JOIN LATERAL public.job_profit_patio_quote(
    f.job_id,
    f.work_type,
    f.status,
    f.quoted_ex,
    f.invoiced_ex,
    f.pricing_json,
    fl.patio AND f.work_type = 'patio'
  ) pq ON true
),
gated AS (
  SELECT
    s.*,
    (
      s.xero_project
      AND s.project_exceeds_line_costs
      AND (
        lower(COALESCE(s.status, '')) IN (
          'complete', 'completed', 'invoiced', 'archived', 'get_review', 'final_payment'
        )
        OR (
          s.work_order_agreed_labour_ex IS NOT NULL
          AND s.work_order_agreed_labour_ex > 0
          AND s.line_labour_ex >= s.work_order_agreed_labour_ex
        )
      )
      AND s.invoiced_ex > 0
      AND NOT s.has_incomplete_invoice
      AND NOT s.has_unclassified
      AND NOT s.has_installer_unconfirmed
    ) AS project_publish
  FROM shown s
)
SELECT
  s.job_id,
  s.org_id,
  s.job_number,
  s.client_name,
  s.work_type,
  s.work_subtype,
  s.status,
  s.created_at,
  CASE
    WHEN s.patio AND s.patio_note IN ('patio_sales_price_conflict', 'ex_inc_conflict') THEN NULL
    WHEN s.patio AND s.patio_note IS NULL AND s.patio_quoted_ex IS NOT NULL THEN s.patio_quoted_ex
    ELSE s.quoted_ex
  END AS quoted_ex,
  CASE
    WHEN s.patio AND s.patio_note IN ('patio_sales_price_conflict', 'ex_inc_conflict') THEN NULL
    WHEN s.patio AND s.patio_note IS NULL AND s.patio_source IS NOT NULL THEN 'patio_quote:' || s.patio_source
    ELSE s.quoted_source
  END AS quoted_source,
  s.shown_expected_source AS expected_source,
  s.shown_labour_ex AS expected_labour_ex,
  s.expected_materials_ex,
  s.expected_commission_ex,
  CASE WHEN s.shown_expected_source IS NOT NULL
       THEN COALESCE(s.shown_labour_ex, 0) + COALESCE(s.expected_materials_ex, 0) + COALESCE(s.expected_commission_ex, 0)
  END AS expected_cost_ex,
  'line_level'::text AS cost_basis,
  s.actual_labour_ex,
  s.actual_materials_ex,
  s.actual_commission_ex,
  s.actual_other_ex,
  s.actual_cost_ex,
  s.line_total_ex AS line_level_cost_ex,
  s.actual_cost_events,
  s.trade_lines_ex,
  s.committed_open_ex,
  s.xero_project_expenses_ex,
  s.xero_project_invoiced_ex,
  s.xero_project_count,
  s.invoiced_ex,
  s.draft_revenue_ex,
  s.variations_listed_ex,
  s.collected_ex,
  s.invoice_count,
  CASE
    WHEN s.project_publish THEN s.invoiced_ex - s.xero_project_expenses_ex
    WHEN s.margin_ok THEN s.invoiced_ex - s.actual_cost_ex
  END AS profit_ex,
  CASE
    WHEN s.project_publish THEN round((s.invoiced_ex - s.xero_project_expenses_ex) / s.invoiced_ex * 100, 1)
    WHEN s.margin_ok THEN round((s.invoiced_ex - s.actual_cost_ex) / s.invoiced_ex * 100, 1)
  END AS margin_pct,
  CASE WHEN NOT s.project_exceeds_line_costs THEN s.invoiced_ex - s.actual_cost_ex END AS profit_ex_unsuppressed,
  (s.invoice_count > 0 AND COALESCE(s.revenue_all_paid, false)) AS revenue_verified_paid,
  (NOT s.project_exceeds_line_costs AND s.actual_cost_events > 0 AND COALESCE(s.cost_all_paid, false)) AS costs_verified_paid,
  s.revenue_last_paid_on,
  s.first_invoice_date,
  s.first_cost_date,
  s.last_cost_date,
  s.revenue_flag,
  CASE WHEN s.project_publish THEN 'ok' ELSE s.cost_flag END AS cost_flag,
  array_remove(ARRAY[
    CASE WHEN s.revenue_flag <> 'ok' THEN s.revenue_flag END,
    CASE WHEN NOT s.has_cost THEN 'no_cost_linked' END,
    CASE WHEN s.has_incomplete_invoice THEN 'incomplete_invoice_lines' END,
    CASE WHEN s.has_unclassified THEN 'unclassified_lines' END,
    CASE WHEN s.has_text_matched THEN 'text_matched_lines' END,
    CASE WHEN s.project_exceeds_line_costs AND NOT s.project_publish THEN 'xero_project_exceeds_line_costs' END,
    CASE WHEN s.has_installer_unconfirmed THEN 'installer_bill_unconfirmed' END,
    CASE WHEN s.project_publish THEN 'margin_from_xero_project' END,
    CASE WHEN s.xero_project AND s.project_exceeds_line_costs AND NOT s.project_publish THEN 'xero_project_margin_held' END,
    CASE WHEN s.has_cost AND s.actual_labour_ex = 0 THEN 'no_labour_linked' END,
    CASE WHEN s.project_contact_only THEN 'xero_project_linked_by_contact_only' END,
    CASE WHEN s.has_cost AND s.materials_missing THEN 'materials_not_linked' END,
    CASE WHEN s.has_unapproved_trade THEN 'unapproved_trade_charges' END,
    CASE WHEN s.committed_open_ex > 0 THEN 'open_purchase_orders' END,
    CASE WHEN s.ordered_not_billed_count > 0 THEN 'ordered_not_billed' END,
    CASE WHEN s.ordered_not_billed_over_30_count > 0 THEN 'ordered_not_billed_over_30_days' END,
    CASE WHEN s.invoice_emailed_count > 0 THEN 'invoice_emailed_bill_not_placed' END,
    CASE WHEN s.draft_revenue_ex > 0 THEN 'draft_revenue' END,
    CASE WHEN s.holding_job THEN 'holding_job' END,
    CASE WHEN s.quote_costs_incomplete THEN 'quote_costs_incomplete' END,
    CASE WHEN s.patio AND s.patio_note IS NOT NULL THEN s.patio_note END
  ], NULL) AS completeness,
  (s.margin_ok OR s.project_publish) AS margin_ok,
  s.holding_job,
  s.ordered_not_billed_count,
  s.ordered_not_billed_over_30_count,
  s.invoice_emailed_count,
  s.invoice_emailed_ex,
  s.quote_costs_incomplete,
  CASE WHEN s.project_publish
       THEN 'from Xero Project, may exclude unlinked labour'
  END AS margin_source,
  CASE WHEN s.project_publish THEN s.xero_project_expenses_ex END AS margin_cost_ex,
  s.expected_labour_ex AS expected_labour_quote_ex,
  s.work_order_agreed_labour_ex
FROM gated s;

COMMENT ON VIEW public.v_job_profit IS
  'Job profit engine (20261009130000, CFO-12 20261019120000, 20261020220000): one row per non-legacy job, all types. Gross profit on direct costs, no overhead. Actual cost is line-level only (trade charges, supplier bills, materials facts). xero_project_expenses_ex is the expenses on record against the job''s Xero Project: evidence only, not the job''s full cost, never in actual cost; where it exceeds the line-level costs the job is flagged xero_project_exceeds_line_costs and profit and margin are null. A Xero Project counts only when its name carries the job''s own job number; one linked by contact only gives no figure and flags xero_project_linked_by_contact_only. quoted_ex is a sent quote only and expected costs are fixed at the quote only; neither is ever a live price or estimate. Margin/profit also null where job_financials would suppress them. committed_open_ex is priced open orders only; unpriced sent orders are counted (ordered_not_billed_count) and orders with an emailed invoice but no placed bill are reported apart (invoice_emailed_count, invoice_emailed_ex). quote_costs_incomplete names a job whose quote costs are still to confirm, so no expected cost is fixed; it is never shown as uncosted.  20261021180000 appends margin_source, margin_cost_ex, expected_labour_quote_ex and work_order_agreed_labour_ex. Three switches default off (job_profit_work_order_labour_v1, job_profit_xero_project_cost_v1, job_profit_patio_quote_v1). An unconfirmed installer bill always flags installer_bill_unconfirmed and blanks profit and margin, and its amount is not in actual cost; that blanking is not behind a switch, so a flags-off completeness list is what 20261020220000 published plus installer_bill_unconfirmed when such a bill is on the job. While the project switch is on, the Xero Project figure is the published cost only when the job is finished or billed labour has reached an approved work order whose agreed labour is above zero, and no installer bill is unconfirmed, and margin_source is exactly ''from Xero Project, may exclude unlinked labour''; a stored agreed labour of 0 does not publish that margin; otherwise the margin stays blank and xero_project_exceeds_line_costs stays set. When that margin publishes, the suppressor is not set and cost_flag is ok. While the labour switch is on, expected labour is an approved job work order only (approved_at is not null); a draft is ignored. While the patio switch is on, a patio sales price is one frozen quote that agrees with the live price and with what has been invoiced; a conflict is blank and flagged. Read only, service role only.';

COMMENT ON COLUMN public.v_job_profit.quote_costs_incomplete IS
  'True when no expected cost is fixed because the revision the quote stands on (newest accepted, else newest sent) sealed its costs as still to confirm (cost_estimates.costs_complete false). Not the same as a job with no costed quote. Never a figure.';

COMMENT ON COLUMN public.v_job_profit.margin_source IS
  'Exactly ''from Xero Project, may exclude unlinked labour'' when that margin is published. Null otherwise. actual_cost_ex stays the linked lines.';
COMMENT ON COLUMN public.v_job_profit.margin_cost_ex IS
  'The Xero Project figure the published margin subtracted. Null when that margin is not published.';
COMMENT ON COLUMN public.v_job_profit.expected_labour_quote_ex IS
  'Expected labour from the quote snapshot, even when expected_labour_ex is an approved job work order.';
COMMENT ON COLUMN public.v_job_profit.work_order_agreed_labour_ex IS
  'Approved job work order agreed labour ex GST, plus approved customer-variation trade allocation. A draft is not included. Shown even while the labour switch is off. Null when no approved job work order has an agreed figure. A stored 0 is a real figure.';
