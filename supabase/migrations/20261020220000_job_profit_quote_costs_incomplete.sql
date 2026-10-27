-- Job profit: name a job whose quote costs are not all known.
--
-- Stacked on 20261020181800_job_cost_allocation_rows (PR #1107, with JP-12)
-- and replaces v_job_profit as that migration leaves it, which itself builds on
-- 20261019120000_job_profit_commitments_truthful (PR #1087, carried in #1107).
-- JP-12 is kept: an installer bill no person has confirmed still flags
-- installer_bill_unconfirmed and blanks profit and margin. PR #1082 adds no
-- migration. Apply only after 20261020181800.
--
-- Since PR #1118 the fence seal writes a quote revision whose costs are still
-- to confirm (pricing_json.internal.costs_complete false) with null cost
-- totals and costs_complete false. Such a revision fixes no expected cost, so
-- before this migration the job read expected_source null, exactly like a job
-- with no costed quote at all. This names it:
--
-- 1. quote_costs_open (new CTE): the revision the job's quote stands on, the
--    newest accepted else the newest sent (the same order the expected-cost
--    sources use), when its cost_estimates carry costs_complete false.
-- 2. quote_costs_incomplete (appended column): true when no expected cost is
--    fixed (no frozen lanes, no costed accepted or sent revision) and that
--    revision is marked incomplete. A job with a fixed expected cost is never
--    flagged, and no expected figure, actual, profit or margin changes.
-- 3. Completeness flag quote_costs_incomplete.
--
-- No table, row, function body or grant changes. Nothing is written.
-- CREATE OR REPLACE VIEW keeps every column in place and appends one.
--
-- Contract: supabase/tests/migration-contracts/20261020220000_job_profit_quote_costs_incomplete/.
-- Rollback: supabase/rollbacks/20261020220000_job_profit_quote_costs_incomplete_down.sql.
-- Not applied anywhere until released (second-model review and ledger dry run first).

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
  LEFT JOIN quote_costs_open qco ON qco.job_id = j.id
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
      AND NOT c.project_exceeds_line_costs AND NOT c.has_installer_unconfirmed
      AND NOT c.materials_missing AND NOT c.labour_missing) AS margin_ok
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
    CASE WHEN f.quote_costs_incomplete THEN 'quote_costs_incomplete' END
  ], NULL) AS completeness,
  f.margin_ok,
  f.holding_job,
  -- CFO-12, appended so every earlier column keeps its place
  f.ordered_not_billed_count,
  f.ordered_not_billed_over_30_count,
  f.invoice_emailed_count,
  f.invoice_emailed_ex,
  -- 20261020220000, appended so every earlier column keeps its place
  f.quote_costs_incomplete
FROM flagged f;

COMMENT ON VIEW public.v_job_profit IS
  'Job profit engine (20261009130000, CFO-12 20261019120000, JP-12 20261020181800, 20261020220000): one row per non-legacy job, all types. Gross profit on direct costs, no overhead. Actual cost is line-level only (trade charges, supplier bills, materials facts). xero_project_expenses_ex is the expenses on record against the job''s Xero Project: evidence only, not the job''s full cost, never in actual cost; where it exceeds the line-level costs the job is flagged xero_project_exceeds_line_costs and profit and margin are null. A Xero Project counts only when its name carries the job''s own job number; one linked by contact only gives no figure and flags xero_project_linked_by_contact_only. quoted_ex is a sent quote only and expected costs are fixed at the quote only; neither is ever a live price or estimate. Margin/profit also null where job_financials would suppress them. committed_open_ex is priced open orders only; unpriced sent orders are counted (ordered_not_billed_count) and orders with an emailed invoice but no placed bill are reported apart (invoice_emailed_count, invoice_emailed_ex). An installer bill on the job that no person has confirmed (JP-12) flags installer_bill_unconfirmed and gives no profit or margin; its amount is not in actual cost. quote_costs_incomplete names a job whose quote costs are still to confirm, so no expected cost is fixed; it is never shown as uncosted. Read only, service role only.';

COMMENT ON COLUMN public.v_job_profit.quote_costs_incomplete IS
  'True when no expected cost is fixed because the revision the quote stands on (newest accepted, else newest sent) sealed its costs as still to confirm (cost_estimates.costs_complete false). Not the same as a job with no costed quote. Never a figure.';
