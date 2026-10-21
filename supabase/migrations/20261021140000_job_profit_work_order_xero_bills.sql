-- Job profit: work-order labour, Xero Project cost, patio quote price.
--
-- Owner's word, 21 Oct 2026. Three switches, all seeded OFF. While a switch
-- is off, missing or unreadable, every existing v_job_profit column and the
-- completeness list stay what 20261009130000 published. The four new columns
-- are evidence only until their switch is on.
--
--   job_profit_work_order_labour_v1
--     expected labour is the job work order's agreed_labour_ex (draft or
--     approved, plus approved customer-variation trade allocation) ahead of
--     the quote snapshot. Crew work orders are not read.
--   job_profit_xero_project_cost_v1
--     when the Xero Project's expenses are higher than the linked line costs,
--     profit and margin use that project figure as the cost and margin_source
--     is 'from Xero Project'. actual_cost_ex stays the linked lines. A missing
--     client invoice, incomplete lines or unclassified lines still hide the
--     margin. materials_not_linked and no_labour_linked do not.
--   job_profit_patio_quote_v1
--     a patio job's sales price is the accepted frozen patio tool quote when
--     that figure is unambiguous. A conflict or an unreadable quote is flagged
--     and is not guessed. The live pricing blob is never the published price.
--
-- Nothing here updates a job, a bill, a quote or a work order. Linking a
-- supplier bill is a later office action, not this migration. The live
-- migration ledger was not read when this version was chosen.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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
  WHEN undefined_table THEN
    RETURN false;
  WHEN OTHERS THEN
    RETURN false;
END;
$fn$;

COMMENT ON FUNCTION public.job_profit_flag_on(text) IS
  'Job profit switches (20261021140000). True only when that feature_flags row exists and is enabled. Missing, unreadable or any error is off.';

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
  'Statuses in which a patio job with no named scope revision and no accepted_at may use its newest frozen tool quote. Quoted and draft are not in this list.';

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
  IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN
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
  'Patio tool quote ex GST from pricing_canonical_text. unreadable or ex_inc_conflict returns no figure. Inc GST alone is divided by 1.1.';

REVOKE ALL ON FUNCTION public.job_profit_flag_on(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_profit_patio_rule3_statuses() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_profit_patio_ex(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_flag_on(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_profit_patio_rule3_statuses() TO service_role;
GRANT EXECUTE ON FUNCTION public.job_profit_patio_ex(text) TO service_role;

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'job_profit_work_order_labour_v1',
  false,
  $d$Job profit expected labour. When on, a job work order's agreed_labour_ex (draft or approved, plus approved customer-variation trade allocation) is expected labour, ahead of the quote snapshot. Off, missing or unreadable: expected labour stays the quote snapshot. Turn on only on the owner's word.$d$
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_work_order_labour_v1'
);

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'job_profit_xero_project_cost_v1',
  false,
  $d$Job profit Xero Project cost. When on, a margin whose Xero Project expenses exceed the linked line costs uses the project figure as the cost and is marked from Xero Project. actual_cost_ex stays the linked lines. Off, missing or unreadable: that margin stays null. Turn on only on the owner's word.$d$
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_xero_project_cost_v1'
);

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'job_profit_patio_quote_v1',
  false,
  $d$Job profit patio sales price. When on, a patio job's quoted figure is its accepted frozen patio tool quote when that figure is unambiguous. A conflict or an unreadable quote is flagged and not guessed. The live price is never published. Off, missing or unreadable: quoted_ex stays the sent quote only. Turn on only on the owner's word.$d$
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_patio_quote_v1'
);

-- The function returns the view's row type. Drop it before the view gains
-- columns, then recreate it after.
DROP FUNCTION IF EXISTS public.job_profit(uuid);

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
    sum(e.amount_ex) FILTER (WHERE NOT e.is_actual) AS committed_open_ex,
    count(*) FILTER (WHERE e.is_actual) AS actual_events,
    bool_and(e.paid) FILTER (WHERE e.is_actual AND e.amount_ex <> 0) AS all_paid,
    bool_or(e.lane_detail = 'unclassified') AS has_unclassified,
    bool_or(e.source = 'trade_line' AND e.match_method <> 'job_id') AS has_text_matched,
    bool_or(e.incomplete_invoice) AS has_incomplete_invoice,
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
    COALESCE(cost.actual_events, 0) AS actual_cost_events,
    cost.all_paid AS cost_all_paid,
    COALESCE(cost.has_unclassified, false) AS has_unclassified,
    COALESCE(cost.has_text_matched, false) AS has_text_matched,
    COALESCE(cost.has_incomplete_invoice, false) AS has_incomplete_invoice,
    COALESCE(cost.has_unapproved_trade, false) AS has_unapproved_trade,
    cost.first_cost_date,
    cost.last_cost_date,
    -- Xero Projects: expenses on record, evidence only, never a cost
    pr.project_expenses_ex AS xero_project_expenses_ex,
    pr.project_invoiced_ex AS xero_project_invoiced_ex,
    COALESCE(pr.project_count, 0) AS xero_project_count,
    COALESCE(pr.contact_only, false) AS project_contact_only,
    -- Job work order agreed labour (draft or approved). Evidence even while
    -- job_profit_work_order_labour_v1 is off; it replaces expected labour only
    -- when that flag is on. Approved customer-variation trade allocation is
    -- included. A draft variation is not. Crew work orders are not.
    wol.agreed_labour_ex AS work_order_agreed_labour_ex,
    -- Accepted patio tool quote. Used only when job_profit_patio_quote_v1 is
    -- on and work_type is patio. Null note means the figure is usable.
    patio.quoted_ex AS patio_quoted_ex,
    patio.note AS patio_note,
    patio.source AS patio_source,
    (j.type = 'patio' AND (
       public.job_profit_num(j.pricing_json -> 'totalExGST') IS NOT NULL
       OR public.job_profit_num(j.pricing_json -> 'totalIncGST') IS NOT NULL
    )) AS patio_live_price
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
  LEFT JOIN LATERAL (
    SELECT wo.agreed_labour_ex + COALESCE(var.trade_ex, 0) AS agreed_labour_ex
    FROM public.work_orders wo
    LEFT JOIN LATERAL (
      SELECT sum(v.trade_allocation_ex) AS trade_ex
      FROM public.work_order_customer_variations v
      WHERE v.work_order_id = wo.id
        AND v.status = 'approved'
    ) var ON true
    WHERE wo.job_id = j.id
      AND wo.kind = 'job'
      AND wo.agreed_labour_ex IS NOT NULL
    ORDER BY wo.created_at DESC NULLS LAST, wo.id
    LIMIT 1
  ) wol ON true
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN r1.id IS NOT NULL THEN px1.quoted_ex
        WHEN j.accepted_at IS NOT NULL THEN px2.quoted_ex
        WHEN scope_id.present IS NOT TRUE
             AND j.status = ANY (public.job_profit_patio_rule3_statuses())
          THEN px3.quoted_ex
      END AS quoted_ex,
      CASE
        WHEN r1.id IS NOT NULL THEN px1.note
        WHEN j.accepted_at IS NOT NULL THEN px2.note
        WHEN scope_id.present IS NOT TRUE
             AND j.status = ANY (public.job_profit_patio_rule3_statuses())
          THEN px3.note
      END AS note,
      CASE
        WHEN r1.id IS NOT NULL AND px1.note IS NULL THEN 'accepted_revision'
        WHEN j.accepted_at IS NOT NULL AND r2.id IS NOT NULL AND px2.note IS NULL THEN 'revision_at_acceptance'
        WHEN scope_id.present IS NOT TRUE
             AND j.status = ANY (public.job_profit_patio_rule3_statuses())
             AND r3.id IS NOT NULL AND px3.note IS NULL
          THEN 'latest_frozen_revision'
      END AS source
    FROM (SELECT NULLIF(btrim(j.expected_costs ->> 'scope_revision_id'), '') IS NOT NULL AS present) scope_id
    LEFT JOIN LATERAL (
      SELECT sr.id, sr.pricing_canonical_text
      FROM public.scope_revisions sr
      WHERE j.type = 'patio'
        AND sr.job_id = j.id
        AND sr.id::text = NULLIF(btrim(j.expected_costs ->> 'scope_revision_id'), '')
        AND sr.status IN ('frozen', 'superseded')
      LIMIT 1
    ) r1 ON true
    LEFT JOIN LATERAL (
      SELECT p.quoted_ex, p.note
      FROM public.job_profit_patio_ex(r1.pricing_canonical_text) p
      WHERE r1.id IS NOT NULL
    ) px1 ON true
    LEFT JOIN LATERAL (
      SELECT sr.id, sr.pricing_canonical_text
      FROM public.scope_revisions sr
      WHERE j.type = 'patio'
        AND r1.id IS NULL
        AND j.accepted_at IS NOT NULL
        AND sr.job_id = j.id
        AND sr.status IN ('frozen', 'superseded')
        AND sr.frozen_at <= j.accepted_at
      ORDER BY sr.frozen_at DESC
      LIMIT 1
    ) r2 ON true
    LEFT JOIN LATERAL (
      SELECT p.quoted_ex, p.note
      FROM public.job_profit_patio_ex(r2.pricing_canonical_text) p
      WHERE r2.id IS NOT NULL
    ) px2 ON true
    LEFT JOIN LATERAL (
      SELECT sr.id, sr.pricing_canonical_text
      FROM public.scope_revisions sr
      WHERE j.type = 'patio'
        AND r1.id IS NULL
        AND j.accepted_at IS NULL
        AND NULLIF(btrim(j.expected_costs ->> 'scope_revision_id'), '') IS NULL
        AND j.status = ANY (public.job_profit_patio_rule3_statuses())
        AND sr.job_id = j.id
        AND sr.status = 'frozen'
      ORDER BY sr.frozen_at DESC NULLS LAST, sr.revision_number DESC
      LIMIT 1
    ) r3 ON true
    LEFT JOIN LATERAL (
      SELECT p.quoted_ex, p.note
      FROM public.job_profit_patio_ex(r3.pricing_canonical_text) p
      WHERE r3.id IS NOT NULL
    ) px3 ON true
    WHERE j.type = 'patio'
  ) patio ON true
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
      AND NOT c.materials_missing AND NOT c.labour_missing) AS margin_ok
  FROM costed c
),
-- Read once per query, not once per job. Missing or unreadable is off.
flags AS MATERIALIZED (
  SELECT
    public.job_profit_flag_on('job_profit_work_order_labour_v1') AS wo_on,
    public.job_profit_flag_on('job_profit_xero_project_cost_v1') AS proj_on,
    public.job_profit_flag_on('job_profit_patio_quote_v1') AS patio_on
),
shown AS (
  SELECT
    f.*,
    fl.wo_on,
    fl.proj_on,
    fl.patio_on,
    CASE
      WHEN fl.wo_on AND f.work_order_agreed_labour_ex IS NOT NULL THEN f.work_order_agreed_labour_ex
      ELSE f.expected_labour_ex
    END AS shown_labour,
    CASE
      WHEN fl.wo_on AND f.work_order_agreed_labour_ex IS NOT NULL THEN 'job_work_order'
      ELSE f.expected_source
    END AS shown_expected_source,
    CASE
      WHEN NOT fl.patio_on OR f.work_type <> 'patio' THEN f.quoted_ex
      WHEN f.patio_note IN ('ex_inc_conflict', 'unreadable') THEN f.quoted_ex
      WHEN f.patio_quoted_ex IS NOT NULL AND f.quoted_ex IS NOT NULL
           AND abs(f.patio_quoted_ex - f.quoted_ex) > 1 THEN NULL
      WHEN f.patio_quoted_ex IS NOT NULL AND f.patio_note IS NULL THEN f.patio_quoted_ex
      ELSE f.quoted_ex
    END AS shown_quoted_ex,
    CASE
      WHEN NOT fl.patio_on OR f.work_type <> 'patio' THEN f.quoted_source
      WHEN f.patio_note IN ('ex_inc_conflict', 'unreadable') THEN f.quoted_source
      WHEN f.patio_quoted_ex IS NOT NULL AND f.quoted_ex IS NOT NULL
           AND abs(f.patio_quoted_ex - f.quoted_ex) > 1 THEN NULL
      WHEN f.patio_quoted_ex IS NOT NULL AND f.patio_note IS NULL AND f.patio_source IS NOT NULL
        THEN 'patio_quote:' || f.patio_source
      ELSE f.quoted_source
    END AS shown_quoted_source,
    -- Project flag on and the project exceeds linked costs: the margin may
    -- use the project figure, so materials_not_linked and no_labour_linked
    -- are no longer the cost flag. Incomplete lines, unclassified lines and
    -- a job with no cost and no publishable margin still are. Flag off keeps
    -- the original cost_flag, including xero_project_exceeds_line_costs.
    CASE
      WHEN NOT (fl.proj_on AND f.project_exceeds_line_costs) THEN f.cost_flag
      WHEN f.has_incomplete_invoice THEN 'incomplete_invoice_lines'
      WHEN f.has_unclassified THEN 'unclassified_lines'
      WHEN NOT f.has_cost
           AND NOT (f.invoiced_ex > 0 AND NOT f.has_incomplete_invoice AND NOT f.has_unclassified)
        THEN 'no_cost_linked'
      ELSE 'ok'
    END AS shown_cost_flag,
    CASE
      WHEN fl.proj_on AND f.project_exceeds_line_costs
        THEN (f.invoiced_ex > 0 AND NOT f.has_incomplete_invoice AND NOT f.has_unclassified)
      ELSE f.margin_ok
    END AS shown_margin_ok
  FROM flagged f
  CROSS JOIN flags fl
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
  s.shown_quoted_ex AS quoted_ex,
  s.shown_quoted_source AS quoted_source,
  s.shown_expected_source AS expected_source,
  s.shown_labour AS expected_labour_ex,
  s.expected_materials_ex,
  s.expected_commission_ex,
  CASE WHEN s.shown_expected_source IS NOT NULL
       THEN COALESCE(s.shown_labour, 0) + COALESCE(s.expected_materials_ex, 0) + COALESCE(s.expected_commission_ex, 0)
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
    WHEN s.shown_margin_ok AND s.proj_on AND s.project_exceeds_line_costs
      THEN s.invoiced_ex - s.xero_project_expenses_ex
    WHEN s.shown_margin_ok THEN s.invoiced_ex - s.actual_cost_ex
  END AS profit_ex,
  CASE
    WHEN s.shown_margin_ok AND s.proj_on AND s.project_exceeds_line_costs
      THEN round((s.invoiced_ex - s.xero_project_expenses_ex) / s.invoiced_ex * 100, 1)
    WHEN s.shown_margin_ok
      THEN round((s.invoiced_ex - s.actual_cost_ex) / s.invoiced_ex * 100, 1)
  END AS margin_pct,
  -- Linked-so-far figure. Stays null when the project exceeds, even when the
  -- published profit uses the project figure.
  CASE WHEN NOT s.project_exceeds_line_costs THEN s.invoiced_ex - s.actual_cost_ex END AS profit_ex_unsuppressed,
  (s.invoice_count > 0 AND COALESCE(s.revenue_all_paid, false)) AS revenue_verified_paid,
  (NOT s.project_exceeds_line_costs AND s.actual_cost_events > 0 AND COALESCE(s.cost_all_paid, false)) AS costs_verified_paid,
  s.revenue_last_paid_on,
  s.first_invoice_date,
  s.first_cost_date,
  s.last_cost_date,
  s.revenue_flag,
  s.shown_cost_flag AS cost_flag,
  array_remove(ARRAY[
    CASE WHEN s.revenue_flag <> 'ok' THEN s.revenue_flag END,
    CASE WHEN NOT s.has_cost THEN 'no_cost_linked' END,
    CASE WHEN s.has_incomplete_invoice THEN 'incomplete_invoice_lines' END,
    CASE WHEN s.has_unclassified THEN 'unclassified_lines' END,
    CASE WHEN s.has_text_matched THEN 'text_matched_lines' END,
    CASE WHEN s.project_exceeds_line_costs THEN 'xero_project_exceeds_line_costs' END,
    CASE WHEN s.has_cost AND s.actual_labour_ex = 0 THEN 'no_labour_linked' END,
    CASE WHEN s.project_contact_only THEN 'xero_project_linked_by_contact_only' END,
    CASE WHEN s.has_cost AND s.materials_missing THEN 'materials_not_linked' END,
    CASE WHEN s.has_unapproved_trade THEN 'unapproved_trade_charges' END,
    CASE WHEN s.committed_open_ex > 0 THEN 'open_purchase_orders' END,
    CASE WHEN s.draft_revenue_ex > 0 THEN 'draft_revenue' END,
    CASE WHEN s.holding_job THEN 'holding_job' END,
    -- Null while the flag is off, so array_remove leaves the old list.
    CASE WHEN s.proj_on AND s.shown_margin_ok AND s.project_exceeds_line_costs THEN 'margin_from_xero_project' END,
    CASE WHEN s.patio_on AND s.work_type = 'patio' AND (
           s.patio_note = 'ex_inc_conflict'
           OR (s.patio_quoted_ex IS NOT NULL AND s.patio_note IS NULL
               AND s.quoted_ex IS NOT NULL AND abs(s.patio_quoted_ex - s.quoted_ex) > 1)
         ) THEN 'patio_sales_price_conflict' END,
    CASE WHEN s.patio_on AND s.work_type = 'patio' AND s.patio_note = 'unreadable' THEN 'patio_sales_price_unreadable' END,
    CASE WHEN s.patio_on AND s.work_type = 'patio'
              AND s.shown_quoted_ex IS NULL
              AND s.patio_quoted_ex IS NULL
              AND s.patio_live_price
              AND s.patio_note IS DISTINCT FROM 'ex_inc_conflict'
              AND s.patio_note IS DISTINCT FROM 'unreadable'
         THEN 'patio_sales_price_live_only' END
  ], NULL) AS completeness,
  s.shown_margin_ok AS margin_ok,
  s.holding_job,
  CASE
    WHEN NOT s.shown_margin_ok THEN NULL
    WHEN s.proj_on AND s.project_exceeds_line_costs THEN 'from Xero Project'
    ELSE 'line_level'
  END AS margin_source,
  CASE
    WHEN NOT s.shown_margin_ok THEN NULL
    WHEN s.proj_on AND s.project_exceeds_line_costs THEN s.xero_project_expenses_ex
    ELSE s.actual_cost_ex
  END AS margin_cost_ex,
  s.expected_labour_ex AS expected_labour_quote_ex,
  s.work_order_agreed_labour_ex
FROM shown s;

COMMENT ON VIEW public.v_job_profit IS
  'Job profit engine (20261009130000, flags 20261021140000). One row per non-legacy job. Gross profit on direct costs, no overhead. Actual cost is line-level only. While job_profit_xero_project_cost_v1 is off, a Xero Project total above the linked lines nulls profit and margin. While it is on, that margin uses the project figure and margin_source is from Xero Project; actual_cost_ex stays the linked lines. While job_profit_work_order_labour_v1 is off, expected labour is the quote snapshot. While it is on, a job work order agreed labour figure replaces it. While job_profit_patio_quote_v1 is off, quoted_ex is a sent quote only. While it is on, an unambiguous accepted patio tool quote is the patio sales price. The live price is never quoted_ex. Read only, service role only.';

COMMENT ON COLUMN public.v_job_profit.xero_project_expenses_ex IS
  'Expenses on record against the job''s Xero Project (name-linked only). Not part of actual_cost_ex. While job_profit_xero_project_cost_v1 is on and this exceeds the linked lines, margin_cost_ex uses it and margin_source is from Xero Project. Trade app labour may sit outside it.';
COMMENT ON COLUMN public.v_job_profit.actual_cost_ex IS
  'Line-level actual cost ex GST (trade charges, supplier bills, materials facts). Never a Xero Project total, even when the published margin uses the project figure.';
COMMENT ON COLUMN public.v_job_profit.quoted_ex IS
  'Sent or accepted quote value ex GST, or, while job_profit_patio_quote_v1 is on, an unambiguous accepted patio tool quote. Null when none, or when the patio figure conflicts with the sent quote. Never the live price.';
COMMENT ON COLUMN public.v_job_profit.expected_cost_ex IS
  'Expected cost. Labour is the quote snapshot, or, while job_profit_work_order_labour_v1 is on, the job work order agreed labour. Materials and commission stay the quote''s. Never the live pricing estimate.';
COMMENT ON COLUMN public.v_job_profit.margin_source IS
  'line_level when the published margin uses linked costs. from Xero Project when job_profit_xero_project_cost_v1 is on and the margin uses the project figure. Null when no margin is published.';
COMMENT ON COLUMN public.v_job_profit.margin_cost_ex IS
  'The cost the published margin subtracted. The Xero Project figure or actual_cost_ex. Null when no margin is published. actual_cost_ex is unchanged.';
COMMENT ON COLUMN public.v_job_profit.expected_labour_quote_ex IS
  'Expected labour from the quote snapshot, even when expected_labour_ex is the job work order figure.';
COMMENT ON COLUMN public.v_job_profit.work_order_agreed_labour_ex IS
  'Job work order agreed labour ex GST, including approved customer-variation trade allocation. Evidence even while the labour switch is off. Null when the job work order has no agreed figure.';

CREATE OR REPLACE FUNCTION public.job_profit(p_job_id uuid)
RETURNS SETOF public.v_job_profit
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM public.v_job_profit WHERE job_id = p_job_id
$fn$;

COMMENT ON FUNCTION public.job_profit(uuid) IS
  'Job profit engine (20261021140000): v_job_profit for one job. Read only, service role only.';

REVOKE ALL ON FUNCTION public.job_profit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit(uuid) TO service_role;
GRANT SELECT ON public.v_job_profit TO service_role;
