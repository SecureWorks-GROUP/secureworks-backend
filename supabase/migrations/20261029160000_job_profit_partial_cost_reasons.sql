-- Job profit TP-13: partial-cost checks as named reasons (29 Oct 2026).
--
-- Ticket TP-13 (framework 08-path-to-trusted-profit, step 8): a job's margin
-- must not look too good because a cost is missing. Each check below is a
-- named reason in v_job_profit.completeness. A check that HOLDS also hides the
-- margin (profit_ex and margin_pct null, margin_ok false) and, when it is a
-- cost, is named in cost_flag. A check that only WARNS is named in
-- completeness and the margin still shows. Which checks hold is
-- job_profit_partial_cost_policy() -> holds_margin, so a later migration flips
-- one without rewriting this body. Nothing here is turned into a figure:
-- expected, committed and actual stay separate and no missing cost is
-- estimated.
--
-- The checks (completeness code; holds the margin?; what it reads):
--   1. materials_below_quote (holds; its switch can make it warn): placed materials above 0 but
--        below materials_below_quote_share of the quote's materials cost
--        (expected_materials_ex). None placed is the existing
--        materials_not_linked. Placing the missing bill clears it.
--   2. Costs against the job's Xero Project total: the existing
--        xero_project_exceeds_line_costs (20261009130000), unchanged.
--   3. po_no_bill_overdue (warns): a priced open order dated po_no_bill_days
--        ago or more (its delivery day, else the Perth day it was created), or
--        a supplier invoice emailed that long ago, with no bill placed.
--        ordered_not_billed_over_30_days (CFO-12, unpriced orders by the day
--        sent) now reads the same limit and also warns. They warn because a
--        person's bill placement records no order (materials_recon.ts writes
--        matched_po_id null), so a placed bill never closes its order and a
--        hold could never clear; nothing here guesses which order a bill
--        closes. v_job_cost_events' po_ rows are the one rule for an open order.
--   4. work_done_no_labour_overdue (never holds by itself): work done
--        (jobs.completed_at, or the first job_client_signoffs row, whichever
--        is earlier) work_done_no_labour_days ago or more with no labour
--        placed. no_labour_linked already holds the margin whenever labour is
--        0; this names the overdue case.
--   5. variation_not_costed (warns): an agreed variation (v_job_revenue_events
--        .agreed) with money on it and no cost figure (job_variations
--        .cost_estimate null). It warns because the variation writer drops a
--        0 cost and the trade app sends none (fixed in ops-api separately).
--   6. variation_not_invoiced (holds): an agreed variation, and the job's
--        invoices fall short of the sent quote plus its agreed variations by
--        more than variation_cover_tolerance_ex. Which invoice bills a
--        variation is not recorded, so only the totals decide.
--        variation_invoice_unchecked (never holds): an agreed variation on a
--        job with no sent quote (quote-builder repairs among them), so there is
--        nothing to check it against.
--   7. expected_cost_lane_missing (never holds): the quote fixed an expected
--        cost with a lane (labour, materials or commission) unknown, so
--        expected_cost_ex is partial. The figure is unchanged (the writer,
--        expected_costs_freeze.ts, leaves an unknown lane out and the sum
--        counts it 0, as before), so no reader's number moves; this marks it.
--
-- The numbers are PROPOSALS (30 days, 14 days, 70 percent, $1.00). 30 days, 14 days and
-- 70 percent are ticket TP-13's own numbers (integrated-framework 02-tickets, TP-13).
-- The new completeness codes are appended after holding_job, so every earlier
-- code keeps its place; revenue_flag is unchanged (ok | missing_client_invoice).
--
-- The story money book (20261028190000) is updated beside it:
-- context_job_story_book names the new cost_flag values and an uninvoiced
-- variation as a revenue gap (not costs_waiting); context_job_story_money_sig
-- covers the job's variations, and, only while the policy makes an order
-- check hold, the order checks' state (the one rule that depends on the
-- clock), so the sweep rewrites a story when either moves. With the policy as
-- shipped no hold depends on the clock and every job's signature is as before
-- unless it has a variation.
--
-- v_job_profit keeps every column, name and type (INT-18), so job_profit(uuid),
-- ops-api job_profit / job_profit_list / rollup, reporting-api and
-- context_job_story_book keep working. v_job_cost_events and
-- v_job_revenue_events are not touched. View body from 20261020181800
-- (section 7); changes are marked TP-13.
--
-- Merge order: PR 1121 (20261020220000) and PR 1132 (20261022180000) also
-- replace v_job_profit. The guard refuses if either is live; if this lands
-- first they would replace this body, so whichever lands second is rebased
-- onto the other.
--
-- Contract: supabase/tests/migration-contracts/20261029160000_job_profit_partial_cost_reasons/.
-- Rollback: supabase/rollbacks/20261029160000_job_profit_partial_cost_reasons_down.sql.

-- ─────────────────────────────────────────────────────────────
-- 0. Guard: the live v_job_profit must be 20261020181800's and the two story
--    book functions 20261028190000's (or this migration's, a re-apply). A
--    successor slice that replaced any of them first must be merged into this
--    body, not lost.
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_cols text[];
  v_def text;
  v_want text[] := ARRAY[
    'job_id', 'org_id', 'job_number', 'client_name', 'work_type', 'work_subtype', 'status', 'created_at',
    'quoted_ex', 'quoted_source', 'expected_source', 'expected_labour_ex', 'expected_materials_ex',
    'expected_commission_ex', 'expected_cost_ex', 'cost_basis', 'actual_labour_ex', 'actual_materials_ex',
    'actual_commission_ex', 'actual_other_ex', 'actual_cost_ex', 'line_level_cost_ex', 'actual_cost_events',
    'trade_lines_ex', 'committed_open_ex', 'xero_project_expenses_ex', 'xero_project_invoiced_ex',
    'xero_project_count', 'invoiced_ex', 'draft_revenue_ex', 'variations_listed_ex', 'collected_ex',
    'invoice_count', 'profit_ex', 'margin_pct', 'profit_ex_unsuppressed', 'revenue_verified_paid',
    'costs_verified_paid', 'revenue_last_paid_on', 'first_invoice_date', 'first_cost_date', 'last_cost_date',
    'revenue_flag', 'cost_flag', 'completeness', 'margin_ok', 'holding_job', 'ordered_not_billed_count',
    'ordered_not_billed_over_30_count', 'invoice_emailed_count', 'invoice_emailed_ex'];
  v_marker text;
  v_fn record;
BEGIN
  IF to_regclass('public.v_job_profit') IS NULL THEN
    RAISE EXCEPTION 'tp13: v_job_profit is missing';
  END IF;
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO v_cols
  FROM pg_attribute a
  WHERE a.attrelid = 'public.v_job_profit'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_cols IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'tp13: v_job_profit columns are not 20261020181800''s (%); rebuild this body on the live one', v_cols;
  END IF;
  v_def := pg_get_viewdef('public.v_job_profit'::regclass);
  IF v_def NOT LIKE '%installer_bill_unconfirmed%' THEN
    RAISE EXCEPTION 'tp13: v_job_profit is older than 20261020181800 (no JP-12 installer rule)';
  END IF;
  -- Markers of open slices that also replace this body (PR 1121, PR 1132):
  -- whichever lands second carries the other's rule.
  FOREACH v_marker IN ARRAY ARRAY['quote_costs_incomplete', 'margin_from_xero_project', 'job_work_order'] LOOP
    IF v_def LIKE '%' || v_marker || '%' THEN
      RAISE EXCEPTION 'tp13: v_job_profit carries % from another slice; merge it into this body first', v_marker;
    END IF;
  END LOOP;
  -- The story money book functions replaced in sections 3 and 4: the
  -- 20261028190000 bodies, or this migration's (a re-apply).
  FOR v_fn IN SELECT * FROM (VALUES
    ('public.context_job_story_money_sig(uuid)', 'dea95169f891563e26f40b1c340897b9'),
    ('public.context_job_story_book(uuid,timestamptz)', 'bd9484273117b728d1d7c021ea6ca4c1')
  ) x(sig, md5_20261028190000) LOOP
    IF to_regprocedure(v_fn.sig) IS NULL THEN
      RAISE EXCEPTION 'tp13: % is missing', v_fn.sig;
    END IF;
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn.sig)) <> v_fn.md5_20261028190000
       AND coalesce(obj_description(to_regprocedure(v_fn.sig), 'pg_proc'), '')
           NOT LIKE 'Story money book (20261028190000), job profit TP-13 (20261029160000):%' THEN
      RAISE EXCEPTION 'tp13: % is neither 20261028190000''s body nor this migration''s; build on the live one', v_fn.sig;
    END IF;
  END LOOP;
  -- Columns this migration reads that the earlier slices did not.
  FOREACH v_marker IN ARRAY ARRAY['job_variations.cost_estimate', 'job_variations.job_id', 'job_variations.status',
      'job_variations.amount', 'job_variations.gst_included', 'job_variations.accepted_at', 'job_variations.declined_at',
      'jobs.completed_at', 'job_client_signoffs.job_id', 'job_client_signoffs.created_at',
      'purchase_orders.delivery_date', 'purchase_orders.created_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(v_marker, '.', 1))
                   AND a.attname = split_part(v_marker, '.', 2) AND a.attnum > 0 AND NOT a.attisdropped) THEN
      RAISE EXCEPTION 'tp13: public.% is missing', v_marker;
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 1. The numbers. Pure; no SET clause so it inlines into the view.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.job_profit_partial_cost_policy()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_build_object(
    'version', 'tp13-v1',
    'po_no_bill_days', 30,
    'work_done_no_labour_days', 14,
    'materials_below_quote_share', 0.7,
    'variation_cover_tolerance_ex', 1.00,
    -- Which checks hide the margin (true) and which only name the gap (false).
    -- Every one is named in completeness either way. A later migration flips
    -- one here; the view body never changes for it.
    'holds_margin', jsonb_build_object(
      'materials_below_quote', true,
      'ordered_not_billed_over_30_days', false,
      'po_no_bill_overdue', false,
      'variation_not_costed', false,
      'variation_not_invoiced', true
    )
  )
$$;

COMMENT ON FUNCTION public.job_profit_partial_cost_policy() IS
  'Job profit TP-13 (20261029160000): the partial-cost check numbers v_job_profit reads. po_no_bill_days: an open order with no bill this many Perth days after its date (a priced order: its delivery day, else the Perth day it was created; an unpriced order: the day it was sent; an emailed invoice: the day it arrived) is po_no_bill_overdue (priced or emailed) or ordered_not_billed_over_30_days (unpriced; the name is CFO-12''s, the limit is this one). work_done_no_labour_days: no labour this many Perth days after completion or first client sign-off is work_done_no_labour_overdue. materials_below_quote_share: placed materials below this share of the quote''s materials cost is materials_below_quote. variation_cover_tolerance_ex: how far invoices may fall short of the sent quote plus agreed variations and still cover them. holds_margin: per check, true hides profit and margin (and names the check in cost_flag when it is a cost), false only names it in completeness; work_done_no_labour_overdue, variation_invoice_unchecked and expected_cost_lane_missing never do. A manual bill placement records no purchase order (materials_recon.ts), so a placed bill never closes an order: the two order checks only warn until that is fixed. Change only by migration. Service role only.';

REVOKE ALL ON FUNCTION public.job_profit_partial_cost_policy() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_partial_cost_policy() TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 2. v_job_profit (from 20261020181800, TP-13 changes marked). Same columns.
-- ─────────────────────────────────────────────────────────────
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
    -- TP-13: the day limit is the policy's (it was a second 30 here); the
    -- column keeps CFO-12's name. An unpriced order is dated by the Perth day
    -- it was sent (v_job_cost_events).
    count(*) FILTER (WHERE e.source = 'po_ordered'
                     AND e.event_date <= (now() AT TIME ZONE 'Australia/Perth')::date
                                         - (public.job_profit_partial_cost_policy() ->> 'po_no_bill_days')::integer) AS ordered_not_billed_over_30_count,
    count(*) FILTER (WHERE e.source = 'po_invoice_emailed') AS invoice_emailed_count,
    -- TP-13: a priced open order or an emailed supplier invoice, with no bill
    -- placed, that many Perth days old or more. A priced order is dated by its
    -- delivery day, else the Perth day it was created (v_job_cost_events dates
    -- it by the session zone's day, so it is read here from the order); an
    -- emailed invoice by the Perth day it arrived.
    count(*) FILTER (WHERE e.source IN ('po_committed', 'po_invoice_emailed')
                     AND CASE WHEN e.source = 'po_committed'
                              THEN (SELECT COALESCE(po.delivery_date, (po.created_at AT TIME ZONE 'Australia/Perth')::date)
                                    FROM public.purchase_orders po WHERE po.id = e.source_id::uuid)
                              ELSE e.event_date
                         END <= (now() AT TIME ZONE 'Australia/Perth')::date
                                - (public.job_profit_partial_cost_policy() ->> 'po_no_bill_days')::integer) AS po_no_bill_overdue_count,
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
-- TP-13: agreed variations (the one agreed rule, v_job_revenue_events.agreed)
-- with money on them, and how many carry no cost figure. Which invoice bills a
-- variation is not recorded (nothing writes job_variations.xero_invoice_id),
-- so invoicing is judged on the job's totals in costed below.
var AS (
  SELECT
    e.job_id,
    count(*) AS variations_agreed,
    count(*) FILTER (WHERE v.cost_estimate IS NULL) AS variations_not_costed
  FROM public.v_job_revenue_events e
  JOIN public.job_variations v ON v.id::text = e.source_id
  WHERE e.kind = 'variation' AND e.agreed AND e.amount_ex > 0
  GROUP BY e.job_id
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
    COALESCE(cost.po_no_bill_overdue_count, 0) AS po_no_bill_overdue_count,
    COALESCE(var.variations_agreed, 0) AS variations_agreed,
    COALESCE(var.variations_not_costed, 0) AS variations_not_costed,
    -- TP-13: the work is done on the earlier of the job's completion and its
    -- first client sign-off (either one, Perth day)
    least((j.completed_at AT TIME ZONE 'Australia/Perth')::date,
          (so.first_signoff_at AT TIME ZONE 'Australia/Perth')::date) AS work_done_on,
    COALESCE(cost.actual_events, 0) AS actual_cost_events,
    cost.all_paid AS cost_all_paid,
    COALESCE(cost.has_unclassified, false) AS has_unclassified,
    COALESCE(cost.has_text_matched, false) AS has_text_matched,
    COALESCE(cost.has_incomplete_invoice, false) AS has_incomplete_invoice,
    COALESCE(cost.has_unapproved_trade, false) AS has_unapproved_trade,
    COALESCE(cost.has_installer_unconfirmed, false) AS has_installer_unconfirmed,
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
  LEFT JOIN rev ON rev.job_id = j.id
  LEFT JOIN collected col ON col.job_id = j.id
  LEFT JOIN cost ON cost.job_id = j.id
  LEFT JOIN project pr ON pr.job_id = j.id
  LEFT JOIN var ON var.job_id = j.id
  LEFT JOIN LATERAL (
    SELECT min(s.created_at) AS first_signoff_at
    FROM public.job_client_signoffs s
    WHERE s.job_id = j.id
  ) so ON true
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
    -- TP-13: materials are placed, but far below the materials cost the quote
    -- fixed (expected_materials_ex), so a bill is probably still to come.
    (s.line_materials_ex > 0
      AND COALESCE(s.expected_materials_ex, 0) > 0
      AND s.line_materials_ex < s.expected_materials_ex
          * (public.job_profit_partial_cost_policy() ->> 'materials_below_quote_share')::numeric) AS materials_below_quote,
    -- TP-13: the work is done (completed or signed off) that many Perth days
    -- ago or more, and no labour cost is placed.
    (s.line_labour_ex = 0
      AND s.work_done_on IS NOT NULL
      AND s.work_done_on <= (now() AT TIME ZONE 'Australia/Perth')::date
                            - (public.job_profit_partial_cost_policy() ->> 'work_done_no_labour_days')::integer) AS work_done_no_labour_overdue,
    -- TP-13: an agreed variation, and the job's invoices fall short of the
    -- sent quote plus its agreed variations: the variation is not invoiced.
    (s.variations_agreed > 0
      AND s.quoted_ex IS NOT NULL
      AND s.invoiced_ex < s.quoted_ex + s.variations_listed_ex
                          - (public.job_profit_partial_cost_policy() ->> 'variation_cover_tolerance_ex')::numeric) AS variation_not_invoiced,
    -- TP-13: an agreed variation on a job with no sent quote, so there is
    -- nothing to check its invoicing against. Named, never a hold.
    (s.variations_agreed > 0 AND s.quoted_ex IS NULL) AS variation_invoice_unchecked,
    s.line_labour_ex AS actual_labour_ex,
    s.line_materials_ex AS actual_materials_ex,
    s.line_commission_ex AS actual_commission_ex,
    s.line_other_ex AS actual_other_ex,
    s.line_total_ex AS actual_cost_ex,
    (s.actual_cost_events > 0) AS has_cost
  FROM basis s
),
-- TP-13: which named checks hide the margin, per the policy's holds_margin.
held AS (
  SELECT
    c.*,
    (c.materials_below_quote
      AND (public.job_profit_partial_cost_policy() -> 'holds_margin' ->> 'materials_below_quote')::boolean) AS materials_below_quote_holds,
    (c.ordered_not_billed_over_30_count > 0
      AND (public.job_profit_partial_cost_policy() -> 'holds_margin' ->> 'ordered_not_billed_over_30_days')::boolean) AS ordered_over_limit_holds,
    (c.po_no_bill_overdue_count > 0
      AND (public.job_profit_partial_cost_policy() -> 'holds_margin' ->> 'po_no_bill_overdue')::boolean) AS po_no_bill_overdue_holds,
    (c.variations_not_costed > 0
      AND (public.job_profit_partial_cost_policy() -> 'holds_margin' ->> 'variation_not_costed')::boolean) AS variation_not_costed_holds,
    (c.variation_not_invoiced
      AND (public.job_profit_partial_cost_policy() -> 'holds_margin' ->> 'variation_not_invoiced')::boolean) AS variation_not_invoiced_holds
  FROM costed c
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
      -- TP-13: a cost check names itself here only while it holds the margin
      WHEN c.materials_below_quote_holds THEN 'materials_below_quote'
      WHEN c.ordered_over_limit_holds THEN 'ordered_not_billed_over_30_days'
      WHEN c.po_no_bill_overdue_holds THEN 'po_no_bill_overdue'
      WHEN c.variation_not_costed_holds THEN 'variation_not_costed'
      WHEN c.has_text_matched THEN 'text_matched_lines'
      ELSE 'ok'
    END AS cost_flag,
    (c.invoiced_ex > 0 AND c.has_cost AND NOT c.has_incomplete_invoice AND NOT c.has_unclassified
      AND NOT c.project_exceeds_line_costs AND NOT c.has_installer_unconfirmed
      AND NOT c.materials_missing AND NOT c.labour_missing
      -- TP-13: a check that holds is a named reason, never a margin
      AND NOT c.materials_below_quote_holds AND NOT c.ordered_over_limit_holds
      AND NOT c.po_no_bill_overdue_holds AND NOT c.variation_not_costed_holds
      AND NOT c.variation_not_invoiced_holds) AS margin_ok
  FROM held c
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
  'line_level'::text AS cost_basis,
  f.actual_labour_ex,
  f.actual_materials_ex,
  f.actual_commission_ex,
  f.actual_other_ex,
  f.actual_cost_ex,
  f.line_total_ex AS line_level_cost_ex,
  f.actual_cost_events,
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
  CASE WHEN NOT f.project_exceeds_line_costs THEN f.invoiced_ex - f.actual_cost_ex END AS profit_ex_unsuppressed,
  (f.invoice_count > 0 AND COALESCE(f.revenue_all_paid, false)) AS revenue_verified_paid,
  (NOT f.project_exceeds_line_costs AND f.actual_cost_events > 0 AND COALESCE(f.cost_all_paid, false)) AS costs_verified_paid,
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
    CASE WHEN f.project_exceeds_line_costs THEN 'xero_project_exceeds_line_costs' END,
    CASE WHEN f.has_installer_unconfirmed THEN 'installer_bill_unconfirmed' END,
    CASE WHEN f.has_cost AND f.actual_labour_ex = 0 THEN 'no_labour_linked' END,
    CASE WHEN f.project_contact_only THEN 'xero_project_linked_by_contact_only' END,
    CASE WHEN f.has_cost AND f.materials_missing THEN 'materials_not_linked' END,
    CASE WHEN f.has_unapproved_trade THEN 'unapproved_trade_charges' END,
    CASE WHEN f.committed_open_ex > 0 THEN 'open_purchase_orders' END,
    CASE WHEN f.ordered_not_billed_count > 0 THEN 'ordered_not_billed' END,
    CASE WHEN f.ordered_not_billed_over_30_count > 0 THEN 'ordered_not_billed_over_30_days' END,
    CASE WHEN f.invoice_emailed_count > 0 THEN 'invoice_emailed_bill_not_placed' END,
    CASE WHEN f.draft_revenue_ex > 0 THEN 'draft_revenue' END,
    CASE WHEN f.holding_job THEN 'holding_job' END,
    -- TP-13, appended so every earlier reason keeps its place
    CASE WHEN f.materials_below_quote THEN 'materials_below_quote' END,
    CASE WHEN f.po_no_bill_overdue_count > 0 THEN 'po_no_bill_overdue' END,
    CASE WHEN f.work_done_no_labour_overdue THEN 'work_done_no_labour_overdue' END,
    CASE WHEN f.variations_not_costed > 0 THEN 'variation_not_costed' END,
    CASE WHEN f.variation_not_invoiced THEN 'variation_not_invoiced' END,
    CASE WHEN f.variation_invoice_unchecked THEN 'variation_invoice_unchecked' END,
    -- TP-13 review: the quote fixed an expected cost but left a lane (labour,
    -- materials or commission) unknown, so expected_cost_ex is partial. The
    -- figure itself is unchanged (a lane it lacks counts 0 in the sum, as
    -- before); this names it.
    CASE WHEN f.expected_source IS NOT NULL
              AND (f.expected_labour_ex IS NULL OR f.expected_materials_ex IS NULL OR f.expected_commission_ex IS NULL)
         THEN 'expected_cost_lane_missing' END
  ], NULL) AS completeness,
  f.margin_ok,
  f.holding_job,
  -- CFO-12, appended so every earlier column keeps its place
  f.ordered_not_billed_count,
  f.ordered_not_billed_over_30_count,
  f.invoice_emailed_count,
  f.invoice_emailed_ex
FROM flagged f;

COMMENT ON VIEW public.v_job_profit IS
  'Job profit engine (20261009130000, CFO-12 20261019120000, JP-12 20261020181800, TP-13 20261029160000): one row per non-legacy job, all types. Gross profit on direct costs, no overhead. Actual cost is line-level only (trade charges, supplier bills, materials facts). xero_project_expenses_ex is the expenses on record against the job''s Xero Project: evidence only, not the job''s full cost, never in actual cost; where it exceeds the line-level costs the job is flagged xero_project_exceeds_line_costs and profit and margin are null. A Xero Project counts only when its name carries the job''s own job number; one linked by contact only gives no figure and flags xero_project_linked_by_contact_only. quoted_ex is a sent quote only and expected costs are fixed at the quote only; neither is ever a live price or estimate. Margin/profit also null where job_financials would suppress them. committed_open_ex is priced open orders only; unpriced sent orders are counted (ordered_not_billed_count) and orders with an emailed invoice but no placed bill are reported apart (invoice_emailed_count, invoice_emailed_ex). An installer bill on the job that no person has confirmed (JP-12) flags installer_bill_unconfirmed and gives no profit or margin; its amount is not in actual cost. TP-13: a cost probably missing is a named reason in completeness: materials_below_quote, ordered_not_billed_over_30_days, po_no_bill_overdue, work_done_no_labour_overdue, variation_not_costed, variation_not_invoiced, variation_invoice_unchecked, expected_cost_lane_missing; those job_profit_partial_cost_policy() makes hold give no profit or margin and, when a cost, are cost_flag. Read only, service role only.';

REVOKE ALL ON public.v_job_profit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_job_profit TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 3. The story money signature (from 20261028190000, TP-13 parts marked):
--    the job's variations, and the order checks' state only while one holds.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.context_job_story_money_sig(p_job_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT md5(concat_ws('|', 'money-sig-v1',
  (SELECT string_agg(concat_ws(',', x.id::text, upper(coalesce(x.invoice_type, '')), upper(coalesce(x.status, '')), x.sub_total::text, x.total::text,
          x.amount_due::text, x.amount_paid::text, x.raw_json ->> 'AmountCredited', to_char(x.due_date, 'YYYY-MM-DD')), ';' ORDER BY x.id)
   FROM public.xero_invoices x WHERE x.job_id = p_job_id),
  (SELECT string_agg(concat_ws(',', f.id::text, f.xero_invoice_id, f.amount_ex_gst::text, f.lane, f.kind), ';' ORDER BY f.id)
   FROM public.job_materials_facts f WHERE f.job_id = p_job_id),
  -- crew lines on the job, and lines with no job that name its number (Job Profit places those by
  -- number or description, v_trade_charge_resolved; a wider net only costs a spare wake)
  (SELECT string_agg(concat_ws(',', l.id::text, l.line_total_ex::text, l.line_type, ti.status, ti.xero_bill_status), ';' ORDER BY l.id)
   FROM public.trade_invoice_lines l LEFT JOIN public.trade_invoices ti ON ti.id = l.trade_invoice_id
   WHERE l.job_id = p_job_id
      OR (l.job_id IS NULL AND (SELECT nullif(btrim(jb.job_number), '') FROM public.jobs jb WHERE jb.id = p_job_id) IS NOT NULL
          AND (upper(btrim(coalesce(l.job_number, ''))) = (SELECT upper(btrim(jb.job_number)) FROM public.jobs jb WHERE jb.id = p_job_id)
               OR upper(coalesce(l.description, '')) LIKE '%' || (SELECT upper(btrim(jb.job_number)) FROM public.jobs jb WHERE jb.id = p_job_id) || '%'))),
  (SELECT string_agg(concat_ws(',', po.id::text, po.status, po.total::text), ';' ORDER BY po.id)
   FROM public.purchase_orders po WHERE po.job_id = p_job_id),
  (SELECT string_agg(concat_ws(',', q.id::text, q.status, q.sub_total::text), ';' ORDER BY q.id)
   FROM public.materials_reconciliation_queue q WHERE q.suggested_job_id = p_job_id AND q.status = 'open'),
  (SELECT string_agg(concat_ws(',', w.id::text, w.kind, w.status, to_char(w.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
          w.agreed_labour_ex::text), ';' ORDER BY w.id)
   FROM public.work_orders w WHERE w.job_id = p_job_id),
  (SELECT string_agg(s.id::text, ';' ORDER BY s.id) FROM public.job_client_signoffs s WHERE s.job_id = p_job_id),
  (SELECT string_agg(concat_ws(',', xp.id::text, xp.total_expenses::text), ';' ORDER BY xp.id::text)
   FROM public.xero_projects xp WHERE xp.job_id = p_job_id),
  (SELECT concat_ws(',', jb.work_order_id::text, to_char(jb.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) FROM public.jobs jb WHERE jb.id = p_job_id),
  -- TP-13 (20261029160000): the job's variations, which Job Profit's variation checks read. NULL for a
  -- job with none, so concat_ws leaves its signature as it was.
  (SELECT string_agg(concat_ws(',', jv.id::text, jv.status, jv.amount::text, jv.gst_included::text, jv.cost_estimate::text,
          to_char(jv.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), to_char(jv.declined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
          ';' ORDER BY jv.id)
   FROM public.job_variations jv WHERE jv.job_id = p_job_id),
  -- TP-13 (20261029160000): an order check that holds the margin moves the book's words with the clock
  -- (a day passes, the order turns overdue). Only while the policy makes one hold, and only on a job
  -- with an order, its state joins the signature; otherwise this is NULL and nothing changes.
  CASE WHEN (public.job_profit_partial_cost_policy() -> 'holds_margin' ->> 'po_no_bill_overdue')::boolean
         OR (public.job_profit_partial_cost_policy() -> 'holds_margin' ->> 'ordered_not_billed_over_30_days')::boolean
       THEN (SELECT nullif(concat_ws(',',
                     CASE WHEN 'ordered_not_billed_over_30_days' = ANY (v.completeness) THEN 'ordered_not_billed_over_30_days' END,
                     CASE WHEN 'po_no_bill_overdue' = ANY (v.completeness) THEN 'po_no_bill_overdue' END), '')
             FROM public.v_job_profit v
             WHERE v.job_id = p_job_id
               AND EXISTS (SELECT 1 FROM public.purchase_orders po WHERE po.job_id = p_job_id))
  END))
$fn$;
COMMENT ON FUNCTION public.context_job_story_money_sig(uuid) IS
 'Story money book (20261028190000), job profit TP-13 (20261029160000): md5 (money-sig-v1) of the rows a job''s Money block is built from: its Xero invoices and bills (type, status, sub total, total, due, paid, credited, due date), placed bill rows (job_materials_facts), crew invoice lines (on the job, or on no job and naming its number) and their invoice''s status and Xero bill status, purchase orders, open bills suggested for it in Bills to place, work orders, client sign-offs, Xero Projects, and the job''s work order and completion time; since TP-13 also the job''s variations (id, status, amount, GST basis, cost figure, accepted and declined times) and, only while job_profit_partial_cost_policy() makes an order check hold, which order checks Job Profit names now (so the day an order turns overdue wakes the story); a job with neither keeps the signature it had. A sync that rewrites a row without changing these leaves it alone. The story writer saves it in checks.money_sig; context_job_story_enqueue_changed wakes the story when it moves. Service role only.';

-- ─────────────────────────────────────────────────────────────
-- 4. The story money book (from 20261028190000, TP-13 parts marked): the new
--    cost_flag values by name, an uninvoiced variation as money not billed.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.context_job_story_book(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_book_policy(); p record;
 v_lines text[] := '{}'; v_job_lines text[] := '{}'; v_reasons text[] := '{}'; v_cost_reasons integer := 0;
 v_txt text; v_n integer; v_amt numeric; v_why text; v_complete boolean; v_started boolean; v_incomplete text;
 v_likely_n integer; v_likely_ex numeric; v_priced_n integer; w record; s record;
 v_lanes_unknown text[] := '{}'; v_expect_reason text;
BEGIN
 IF p_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id) THEN
  RETURN NULL;
 END IF;
 SELECT * INTO p FROM public.v_job_profit v WHERE v.job_id = p_job_id;
 -- bills that probably belong to the job, waiting in Bills to place
 SELECT count(*)::integer, coalesce(sum(q.sub_total), 0) INTO v_likely_n, v_likely_ex
 FROM public.materials_reconciliation_queue q WHERE q.suggested_job_id = p_job_id AND q.status = 'open';
 IF p.job_id IS NULL THEN
  -- a legacy job: Job Profit has no row, so the book says so and nothing else
  v_lines := ARRAY['Money: Job Profit has no record of this job, so no figures are shown.'];
  v_incomplete := 'Costs incomplete: Job Profit has no record of this job.';
  RETURN jsonb_build_object('version', pol ->> 'version', 'job_id', p_job_id, 'source', 'none', 'complete', false, 'started', false,
   'reason', 'no_job_profit_row', 'reasons', jsonb_build_array('no_job_profit_row'), 'lines', to_jsonb(v_lines), 'job_lines', '[]'::jsonb,
   'incomplete_line', v_incomplete, 'facts', '{}'::jsonb,
   'digest', md5(jsonb_build_object('v', pol ->> 'version', 'lines', to_jsonb(v_lines), 'incomplete', v_incomplete)::text),
   'money_sig', public.context_job_story_money_sig(p_job_id));
 END IF;

 -- Quoted and expected
 v_lines := v_lines || CASE WHEN p.quoted_ex IS NOT NULL THEN 'Quoted: ' || public.context_job_story_money_words(p.quoted_ex) || ' ex GST.'
                            ELSE 'Quoted: no sent quote is on record.' END;
 IF p.expected_source IS NOT NULL THEN
  -- TP-13 review: a lane the quote left unknown is "not known", never $0.00,
  -- and the total is then partial (expected_cost_lane_missing). A lane the
  -- quote fixed at zero still reads $0.00.
  IF p.expected_labour_ex IS NULL THEN v_lanes_unknown := v_lanes_unknown || 'labour'::text; END IF;
  IF p.expected_materials_ex IS NULL THEN v_lanes_unknown := v_lanes_unknown || 'materials'::text; END IF;
  IF p.expected_commission_ex IS NULL THEN v_lanes_unknown := v_lanes_unknown || 'commission'::text; END IF;
  v_lines := v_lines || ('Expected cost at the quote: '
   || CASE WHEN cardinality(v_lanes_unknown) > 0 THEN 'at least ' ELSE '' END
   || public.context_job_story_money_words(p.expected_cost_ex) || ' ex GST'
   || CASE WHEN cardinality(v_lanes_unknown) > 0 THEN ', partial' ELSE '' END || ' (labour '
   || coalesce(public.context_job_story_money_words(p.expected_labour_ex), 'not known') || ', materials '
   || coalesce(public.context_job_story_money_words(p.expected_materials_ex), 'not known') || ', commission '
   || coalesce(public.context_job_story_money_words(p.expected_commission_ex), 'not known') || ').');
  IF cardinality(v_lanes_unknown) > 0 THEN
   v_expect_reason := 'the expected cost at the quote is partial, its '
    || CASE cardinality(v_lanes_unknown) WHEN 1 THEN v_lanes_unknown[1] || ' is'
       WHEN 2 THEN v_lanes_unknown[1] || ' and ' || v_lanes_unknown[2] || ' are'
       ELSE 'labour, materials and commission are' END || ' not known';
  END IF;
 END IF;

 -- Invoiced, collected, by payer, owing now
 IF coalesce(p.invoice_count, 0) = 0 THEN
  v_lines := v_lines || 'Invoiced: no customer invoice is issued yet.'::text;
 ELSE
  v_lines := v_lines || ('Invoiced: ' || public.context_job_story_money_words(p.invoiced_ex) || ' ex GST on ' || p.invoice_count
   || CASE WHEN p.invoice_count = 1 THEN ' invoice' ELSE ' invoices' END || '; collected '
   || public.context_job_story_money_words(p.collected_ex) || ' ex GST.');
  SELECT count(*)::integer, string_agg(x.party || ' ' || public.context_job_story_money_words(x.ex), ', ' ORDER BY x.ex DESC, x.party COLLATE "C")
         FILTER (WHERE x.o <= (pol ->> 'payers_max')::integer)
  INTO v_n, v_txt
  FROM (SELECT coalesce(nullif(btrim(e.party), ''), 'a payer not named') AS party, sum(e.amount_ex) AS ex,
               row_number() OVER (ORDER BY sum(e.amount_ex) DESC, coalesce(nullif(btrim(e.party), ''), 'a payer not named') COLLATE "C") AS o
        FROM public.v_job_revenue_events e WHERE e.job_id = p_job_id AND e.counts_as_invoiced
        GROUP BY 1) x;
  IF v_n > 1 THEN
   v_lines := v_lines || ('Invoiced by payer (ex GST): ' || v_txt
    || CASE WHEN v_n > (pol ->> 'payers_max')::integer THEN ' and ' || (v_n - (pol ->> 'payers_max')::integer) || ' more' ELSE '' END || '.');
  END IF;
 END IF;
 IF coalesce(p.draft_revenue_ex, 0) > 0 THEN
  v_lines := v_lines || ('Draft invoices, never issued: ' || public.context_job_story_money_words(p.draft_revenue_ex) || ' ex GST.');
 END IF;
 FOR w IN
  SELECT x.invoice_number, x.amount_due, x.due_date, row_number() OVER (ORDER BY x.due_date NULLS LAST, x.invoice_number COLLATE "C", x.id) AS o,
         count(*) OVER () AS n
  FROM public.xero_invoices x
  WHERE x.job_id = p_job_id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
    AND upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED') AND coalesce(x.amount_due, 0) > 0
  ORDER BY 4
 LOOP
  IF w.o <= (pol ->> 'owing_max')::integer THEN
   v_lines := v_lines || ('Owing now on ' || coalesce(nullif(btrim(w.invoice_number), ''), 'an invoice without a number') || ': '
    || public.context_job_story_money_words(w.amount_due) || ' inc GST'
    || CASE WHEN w.due_date IS NOT NULL THEN ', due ' || to_char(w.due_date, 'Dy FMDD Mon YYYY') ELSE '' END || '.');
  ELSIF w.o = (pol ->> 'owing_max')::integer + 1 THEN
   v_lines := v_lines || ('Owing now on ' || (w.n - (pol ->> 'owing_max')::integer) || ' more invoices.');
  END IF;
 END LOOP;

 -- Costs placed
 v_lines := v_lines || ('Labour placed: ' || public.context_job_story_money_words(p.actual_labour_ex) || ' ex GST.');
 SELECT count(*)::integer, string_agg(x.party || ' ' || public.context_job_story_money_words(x.ex), ', ' ORDER BY x.ex DESC, x.party COLLATE "C")
        FILTER (WHERE x.o <= (pol ->> 'crew_max')::integer)
 INTO v_n, v_txt
 FROM (SELECT coalesce(nullif(btrim(e.party), ''), 'a crew member not named') AS party, sum(e.amount_ex) AS ex,
              row_number() OVER (ORDER BY sum(e.amount_ex) DESC, coalesce(nullif(btrim(e.party), ''), 'a crew member not named') COLLATE "C") AS o
       FROM public.v_job_cost_events e WHERE e.job_id = p_job_id AND e.source = 'trade_line' AND e.is_actual
       GROUP BY 1) x;
 IF v_n > 0 THEN
  v_lines := v_lines || ('Crew invoices placed (ex GST): ' || v_txt
   || CASE WHEN v_n > (pol ->> 'crew_max')::integer THEN ' and ' || (v_n - (pol ->> 'crew_max')::integer) || ' more' ELSE '' END || '.');
 END IF;
 v_lines := v_lines || ('Materials placed: ' || public.context_job_story_money_words(p.actual_materials_ex) || ' ex GST.');
 IF coalesce(p.actual_commission_ex, 0) <> 0 OR coalesce(p.expected_commission_ex, 0) > 0 THEN
  v_lines := v_lines || ('Commission placed: ' || public.context_job_story_money_words(p.actual_commission_ex) || ' ex GST.');
 END IF;
 IF coalesce(p.actual_other_ex, 0) <> 0 THEN
  v_lines := v_lines || ('Other costs placed: ' || public.context_job_story_money_words(p.actual_other_ex) || ' ex GST.');
 END IF;
 v_lines := v_lines || ('Total costs placed: ' || public.context_job_story_money_words(p.actual_cost_ex) || ' ex GST.');

 -- Costs still coming
 SELECT count(*)::integer INTO v_priced_n FROM public.v_job_cost_events e WHERE e.job_id = p_job_id AND e.source = 'po_committed';
 IF coalesce(p.committed_open_ex, 0) > 0 THEN
  v_lines := v_lines || ('Ordered, not billed yet: ' || public.context_job_story_money_words(p.committed_open_ex) || ' ex GST on '
   || v_priced_n || CASE WHEN v_priced_n = 1 THEN ' priced purchase order.' ELSE ' priced purchase orders.' END);
 END IF;
 IF coalesce(p.ordered_not_billed_count, 0) > 0 THEN
  v_lines := v_lines || ('Purchase orders sent with no price and no bill yet: ' || p.ordered_not_billed_count || '.');
 END IF;
 IF coalesce(p.invoice_emailed_count, 0) > 0 THEN
  v_lines := v_lines || ('Supplier invoices emailed for an order, bill not placed on this job yet: ' || p.invoice_emailed_count
   || CASE WHEN coalesce(p.invoice_emailed_ex, 0) > 0 THEN ', ' || public.context_job_story_money_words(p.invoice_emailed_ex) || ' ex GST' ELSE '' END || '.');
 END IF;
 IF v_likely_n > 0 THEN
  v_lines := v_lines || ('Bills that probably belong to this job, waiting to be placed: ' || v_likely_n || ', '
   || public.context_job_story_money_words(v_likely_ex) || ' ex GST.');
 END IF;
 IF coalesce(p.xero_project_count, 0) > 0 AND p.xero_project_expenses_ex IS NOT NULL THEN
  v_lines := v_lines || ('Xero Project expenses on record: ' || public.context_job_story_money_words(p.xero_project_expenses_ex)
   || ' ex GST (a cross-check, not counted as cost).');
 END IF;

 -- The job's work order
 SELECT wo.status, wo.approved_at, wo.agreed_labour_ex INTO w
 FROM public.jobs jb JOIN public.work_orders wo ON wo.id = jb.work_order_id WHERE jb.id = p_job_id;
 IF w.status IS NOT NULL THEN
  v_lines := v_lines || CASE WHEN w.approved_at IS NOT NULL
   THEN 'Work order: approved ' || to_char((w.approved_at AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon YYYY')
        || CASE WHEN w.agreed_labour_ex IS NOT NULL THEN ', agreed labour ' || public.context_job_story_money_words(w.agreed_labour_ex) || ' ex GST' ELSE '' END || '.'
   ELSE 'Work order: drafted, not approved yet.' END;
 ELSIF p.work_type IN ('fencing', 'patio', 'decking', 'combo') THEN
  v_lines := v_lines || 'Work order: none on record.'::text;
 END IF;

 -- What is still missing, and the margin
 IF p.revenue_flag IS DISTINCT FROM 'ok' THEN v_reasons := v_reasons || 'no customer invoice is issued yet'::text; END IF;
 -- TP-13 (20261029160000): an agreed variation the invoices do not cover is money not billed yet, not a cost
 IF 'variation_not_invoiced' = ANY (coalesce(p.completeness, '{}'::text[])) THEN
  v_reasons := v_reasons || 'an agreed variation is not covered by the invoices yet'::text;
 END IF;
 v_why := CASE p.cost_flag
  WHEN 'xero_project_exceeds_line_costs' THEN 'the Xero Project shows more costs than are placed on this job'
  WHEN 'installer_bill_unconfirmed' THEN 'an installer bill on this job is waiting for a person to confirm it'
  WHEN 'no_cost_linked' THEN 'no costs are placed on this job yet'
  WHEN 'incomplete_invoice_lines' THEN 'a crew invoice on this job has incomplete lines'
  WHEN 'unclassified_lines' THEN 'some cost lines are not sorted into labour or materials'
  WHEN 'materials_not_linked' THEN 'no materials bills are placed on this job yet'
  WHEN 'no_labour_linked' THEN 'no crew pay or labour is placed on this job yet'
  -- TP-13 (20261029160000): the partial-cost checks that name themselves in cost_flag while they hold.
  -- The words carry no day count, so a day passing alone never changes them.
  WHEN 'materials_below_quote' THEN 'the materials bills placed are well under the materials in the quote, so a bill is probably still to come'
  WHEN 'ordered_not_billed_over_30_days' THEN 'a purchase order sent with no price is still waiting for its bill'
  WHEN 'po_no_bill_overdue' THEN 'a purchase order is still waiting for its bill'
  WHEN 'variation_not_costed' THEN 'an agreed variation has no cost figure'
  END;
 IF v_why IS NOT NULL THEN v_reasons := v_reasons || v_why; v_cost_reasons := v_cost_reasons + 1; END IF;
 IF v_likely_n > 0 THEN
  v_reasons := v_reasons || (v_likely_n || CASE WHEN v_likely_n = 1 THEN ' bill that probably belongs to this job is' ELSE ' bills that probably belong to this job are' END
   || ' waiting to be placed');
  v_cost_reasons := v_cost_reasons + 1;
 END IF;
 IF v_priced_n > 0 THEN
  v_reasons := v_reasons || (v_priced_n || CASE WHEN v_priced_n = 1 THEN ' priced purchase order has' ELSE ' priced purchase orders have' END || ' no bill yet');
  v_cost_reasons := v_cost_reasons + 1;
 END IF;
 IF coalesce(p.ordered_not_billed_count, 0) > 0 THEN
  v_reasons := v_reasons || (p.ordered_not_billed_count || CASE WHEN p.ordered_not_billed_count = 1 THEN ' purchase order with no price has' ELSE ' purchase orders with no price have' END
   || ' no bill yet');
  v_cost_reasons := v_cost_reasons + 1;
 END IF;
 IF coalesce(p.invoice_emailed_count, 0) > 0 THEN
  v_reasons := v_reasons || (p.invoice_emailed_count || CASE WHEN p.invoice_emailed_count = 1 THEN ' supplier invoice was' ELSE ' supplier invoices were' END
   || ' emailed but its bill is not placed');
  v_cost_reasons := v_cost_reasons + 1;
 END IF;
 -- The expectation being partial does not touch the actual margin, so it is
 -- named after the margin line is built and never makes it "so far"; it
 -- still keeps the book from reading complete.
 v_complete := coalesce(p.margin_ok, false) AND cardinality(v_reasons) = 0 AND v_expect_reason IS NULL;
 v_started := coalesce(p.invoice_count, 0) > 0 OR coalesce(p.actual_cost_events, 0) > 0 OR v_likely_n > 0 OR v_priced_n > 0
  OR coalesce(p.ordered_not_billed_count, 0) > 0 OR coalesce(p.invoice_emailed_count, 0) > 0 OR coalesce(p.draft_revenue_ex, 0) > 0;
 v_lines := v_lines || CASE WHEN coalesce(p.margin_ok, false) AND p.profit_ex IS NOT NULL
  THEN 'Margin: ' || public.context_job_story_money_words(p.profit_ex) || ' ex GST profit, ' || p.margin_pct::text || '% of invoiced'
       || CASE WHEN cardinality(v_reasons) = 0 THEN '.' ELSE ', on the costs placed so far.' END
  ELSE 'Margin: Unknown, because ' || coalesce(v_reasons[1], CASE WHEN p.holding_job THEN 'this is a holding job, not a customer''s job'
                                                               ELSE 'Job Profit does not show one' END) || '.' END;
 IF NOT v_complete THEN
  IF cardinality(v_reasons) = 0 AND NOT coalesce(p.margin_ok, false) THEN
   v_incomplete := 'Costs incomplete: Job Profit does not show a margin yet'
    || CASE WHEN v_expect_reason IS NOT NULL THEN '; ' || v_expect_reason ELSE '' END || '.';
  ELSE
   v_incomplete := CASE WHEN v_cost_reasons > 0 THEN 'Costs incomplete: ' ELSE 'Money incomplete: ' END
    || array_to_string(v_reasons || v_expect_reason, '; ') || '.';
  END IF;
  v_lines := v_lines || v_incomplete;
 END IF;
 IF v_expect_reason IS NOT NULL THEN v_reasons := v_reasons || v_expect_reason; END IF;

 -- The job lines the writer reads beside the money: the client's sign-off
 SELECT sg.method, sg.happy, sg.created_at INTO s FROM public.job_client_signoffs sg
 WHERE sg.job_id = p_job_id ORDER BY sg.created_at DESC, sg.id DESC LIMIT 1;
 v_job_lines := v_job_lines || CASE WHEN s.created_at IS NULL THEN 'Client sign-off: none on record.'
  ELSE 'Client sign-off: ' || CASE WHEN s.method = 'office_waiver' THEN 'waived by the office' ELSE 'signed on site' END || ' '
       || to_char((s.created_at AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon YYYY')
       || CASE WHEN s.happy IS TRUE THEN ', the customer said they were happy' WHEN s.happy IS FALSE THEN ', the customer said they were not happy' ELSE '' END || '.' END;

 RETURN jsonb_build_object(
  'version', pol ->> 'version',
  'job_id', p_job_id,
  'source', 'job_profit',
  'complete', v_complete,
  'started', v_started,
  'reason', CASE WHEN v_complete THEN 'complete' WHEN p.revenue_flag IS DISTINCT FROM 'ok' AND p.cost_flag IN ('ok', 'text_matched_lines') THEN p.revenue_flag
                 WHEN p.cost_flag NOT IN ('ok', 'text_matched_lines') THEN p.cost_flag
                 WHEN 'variation_not_invoiced' = ANY (coalesce(p.completeness, '{}'::text[])) THEN 'variation_not_invoiced'
                 WHEN v_expect_reason IS NOT NULL AND cardinality(v_reasons) = 1 THEN 'expected_cost_lane_missing'
                 ELSE 'costs_waiting' END,
  'reasons', to_jsonb(v_reasons),
  'lines', to_jsonb(v_lines),
  'job_lines', to_jsonb(v_job_lines),
  'incomplete_line', v_incomplete,
  'facts', jsonb_build_object('margin_ok', coalesce(p.margin_ok, false), 'cost_flag', p.cost_flag, 'revenue_flag', p.revenue_flag,
   'likely_unplaced_bills', v_likely_n, 'priced_orders_open', v_priced_n, 'orders_unpriced_open', coalesce(p.ordered_not_billed_count, 0),
   'invoices_emailed_unplaced', coalesce(p.invoice_emailed_count, 0), 'signed_off', s.created_at IS NOT NULL, 'work_order', coalesce(w.status, 'none')),
  'digest', md5(jsonb_build_object('v', pol ->> 'version', 'lines', to_jsonb(v_lines), 'job_lines', to_jsonb(v_job_lines),
                                   'incomplete', v_incomplete)::text),
  'money_sig', public.context_job_story_money_sig(p_job_id));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_book(uuid, timestamptz) IS
 'Story money book (20261028190000), job profit TP-13 (20261029160000): the job''s money in fixed plain lines from Job Profit (v_job_profit, v_job_cost_events, v_job_revenue_events, the engine Job Profit''s screen reads; figures are the engine''s, formatted, never worked out here): {version story-book-v1, job_id, source job_profit|none, complete, started (any invoice, cost, order or waiting bill), reason, reasons, lines, job_lines, incomplete_line, facts, digest, money_sig}. lines: quoted; expected cost at the quote; invoiced and collected (ex GST) and by payer; owing now per invoice (Xero, inc GST); labour, and crew invoices by crew member; materials, commission, other and total costs placed; priced orders not billed, unpriced orders, invoices emailed with no bill placed; bills that probably belong to the job waiting in Bills to place (open queue rows suggested for it); the Xero Project total (a cross-check); the job work order; the margin or "Unknown, because ..." (since TP-13 naming materials_below_quote, the order checks and variation_not_costed when they hold, and an agreed variation the invoices do not cover as money not billed, reason variation_not_invoiced); and, unless complete, one "Costs incomplete: ..." (or "Money incomplete: ...") line with counts and no dollar figure. complete: Job Profit shows a margin, nothing is waiting and the quote''s expected cost knows every lane. A lane the quote left unknown reads "not known", never $0.00, the expected total reads "at least ..., partial" and is named in reasons and the incomplete line (reason expected_cost_lane_missing); the margin, an actual figure, is shown unchanged. job_lines: the client sign-off. digest: md5 of the words. Days are written with their year and nothing says overdue, so the clock alone never changes the words (p_as_of is kept for callers and changes nothing). NULL for an unknown job. Read only. Service role only.';

REVOKE ALL ON FUNCTION public.context_job_story_money_sig(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_money_sig(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.context_job_story_book(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_book(uuid, timestamptz) TO service_role;
