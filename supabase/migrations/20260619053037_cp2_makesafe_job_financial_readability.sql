-- ============================================================
-- MIGRATION: CP2 MakeSafe job-financial readability repair
-- Timestamp: 20260619053037
-- Campaign: Profitability / Job-Costing
-- Mission: MakeSafe trade-cost control CP2
--
-- Status: LOCAL DRAFT — do not apply to production until Marnin gates DB changes.
--
-- Purpose:
--   The CP2 live dry-run proved the job_financials container exists but is
--   too sparse/ambiguous to be treated as profitability truth. This migration
--   makes the existing read model more honest and agent-readable without
--   changing money writes, Xero writes, invoice creation, or trade submit.
--
-- Repairs:
--   1. Resolve ACCREC revenue by direct job_id OR exact xero_invoices.job_number.
--   2. Resolve trade cost by direct job_id OR exact line job_number OR weak
--      description job-number extraction, with match_method exposed.
--   3. Exclude QA/test-labelled trade lines from trusted cost/margin aggregates.
--   4. Add MakeSafe expected-labour fields: min hours per trade, expected trade
--      count, expected total hours, source and status. These are explanatory;
--      they do not become cost lanes.
--   5. Add multi-flag data_quality_flags so one row can honestly say both
--      "missing labour" and "text matched" instead of hiding behind one flag.
--   6. Suppress margin unless revenue and cost are trustworthy and non-test.
--
-- Live safety:
--   - DDL/read model only; no data UPDATE/INSERT/DELETE.
--   - No Edge Function deploy in this migration.
--   - get_job_financials is dropped/recreated because its return type changes.
-- ============================================================

-- ------------------------------------------------------------
-- A. Revenue resolver: ACCREC revenue belongs to a job by direct FK first,
--    then by exact xero_invoices.job_number. No fuzzy reference matching here.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_job_revenue_resolved AS
SELECT
  xi.id AS xero_invoice_row_id,
  xi.xero_invoice_id,
  xi.invoice_number,
  xi.invoice_type,
  xi.status,
  xi.reference,
  jd.id AS direct_job_id,
  COALESCE(jd.id, jn.id) AS resolved_job_id,
  CASE
    WHEN jd.id IS NOT NULL THEN 'job_id'
    WHEN xi.job_number IS NOT NULL AND jn.id IS NOT NULL THEN 'xero_job_number'
    ELSE 'unresolved'
  END AS revenue_match_method,
  (jd.id IS NOT NULL) AS revenue_attributed_direct,
  xi.job_number AS xero_job_number,
  xi.contact_name,
  xi.invoice_date,
  xi.due_date,
  xi.sub_total,
  xi.total_tax,
  xi.total,
  xi.amount_due,
  xi.amount_paid,
  xi.line_items,
  xi.synced_at,
  xi.created_at,
  xi.updated_at
FROM public.xero_invoices xi
LEFT JOIN public.jobs jd
  ON jd.id = xi.job_id
 AND jd.org_id = xi.org_id
LEFT JOIN public.jobs jn
  ON jn.job_number = xi.job_number
 AND jn.org_id = xi.org_id
 AND jd.id IS NULL
WHERE xi.invoice_type = 'ACCREC'
  AND xi.status NOT IN ('VOIDED', 'DELETED');

COMMENT ON VIEW public.v_job_revenue_resolved IS
  'CP2 job-costing revenue resolver. Direct xero_invoices.job_id wins; exact same-org xero_invoices.job_number is the only fallback. No fuzzy reference matching.';

-- ------------------------------------------------------------
-- B. Trade-charge resolver: keep direct links trustworthy, allow weak
--    description job-number matches only as flagged evidence.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_trade_charge_resolved AS
WITH line_base AS (
  SELECT
    til.*,
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
    WHEN lb.line_type IN ('labour', 'fencing', 'patio', 'make safe', 'general labour')
      THEN 'labour'
    WHEN lb.line_type = 'materials'
      THEN 'materials'
    WHEN lb.line_type = 'commission'
      THEN 'commission'
    WHEN lb.line_type IN ('travel', 'equipment', 'other')
      THEN 'other'
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
  END AS exclusion_reason
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
  'CP2 canonical trade-cost resolver. Direct and job-number fallbacks are scoped by trade invoice org_id; probable QA/test lines are excluded from trusted aggregates downstream.';

-- ------------------------------------------------------------
-- C. Expected MakeSafe labour baseline. This is an explanatory baseline,
--    not a cost lane. It is intentionally source-labelled.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_makesafe_expected_labour AS
WITH latest_report AS (
  SELECT DISTINCT ON (jsr.job_id)
    jsr.job_id,
    jsr.status AS report_status,
    jsr.checklist_json,
    jsr.submitted_at,
    jsr.updated_at,
    CASE
      WHEN jsonb_typeof(jsr.checklist_json) = 'object'
       AND (jsr.checklist_json->>'trade_count') ~ '^[0-9]+$'
      THEN NULLIF(jsr.checklist_json->>'trade_count', '')::int
      ELSE NULL
    END AS report_trade_count,
    CASE
      WHEN jsonb_typeof(jsr.checklist_json) = 'object'
       AND (jsr.checklist_json->>'labour_hours') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN NULLIF(jsr.checklist_json->>'labour_hours', '')::numeric
      ELSE NULL
    END AS report_labour_hours
  FROM public.job_service_reports jsr
  WHERE jsr.status IN ('submitted', 'approved')
  ORDER BY jsr.job_id, jsr.submitted_at DESC NULLS LAST, jsr.updated_at DESC NULLS LAST, jsr.created_at DESC
),
assignment_counts AS (
  SELECT
    ja.job_id,
    COUNT(DISTINCT ja.user_id)::int AS assigned_trade_count
  FROM public.job_assignments ja
  WHERE ja.role IN ('lead_installer', 'helper')
  GROUP BY ja.job_id
),
base AS (
  SELECT
    j.id AS job_id,
    CASE
      WHEN (mjd.billing_rules->>'min_hours') ~ '^[0-9]+(\.[0-9]+)?$'
        THEN (mjd.billing_rules->>'min_hours')::numeric
      WHEN (mc.billing_rules->>'min_hours') ~ '^[0-9]+(\.[0-9]+)?$'
        THEN (mc.billing_rules->>'min_hours')::numeric
      ELSE 2::numeric
    END AS expected_min_hours_per_trade,
    CASE
      WHEN (mjd.billing_rules->>'authorised_trade_count') ~ '^[0-9]+$'
        THEN (mjd.billing_rules->>'authorised_trade_count')::int
      WHEN (mjd.billing_rules->>'authorized_trade_count') ~ '^[0-9]+$'
        THEN (mjd.billing_rules->>'authorized_trade_count')::int
      WHEN lr.report_trade_count IS NOT NULL AND lr.report_trade_count > 0
        THEN lr.report_trade_count
      WHEN ac.assigned_trade_count IS NOT NULL AND ac.assigned_trade_count > 0
        THEN ac.assigned_trade_count
      ELSE NULL
    END AS expected_trade_count,
    CASE
      WHEN (mjd.billing_rules->>'authorised_trade_count') ~ '^[0-9]+$'
        OR (mjd.billing_rules->>'authorized_trade_count') ~ '^[0-9]+$'
        THEN 'makesafe_job_details.billing_rules.authorised_trade_count'
      WHEN lr.report_trade_count IS NOT NULL AND lr.report_trade_count > 0
        THEN 'job_service_reports.checklist_json.trade_count'
      WHEN ac.assigned_trade_count IS NOT NULL AND ac.assigned_trade_count > 0
        THEN 'job_assignments.distinct_user_count'
      ELSE 'default_min_hours_only_trade_count_missing'
    END AS expected_labour_source,
    CASE
      WHEN (mjd.billing_rules->>'authorised_trade_count') ~ '^[0-9]+$'
        OR (mjd.billing_rules->>'authorized_trade_count') ~ '^[0-9]+$'
        THEN 'stamped_authorised_trade_count'
      WHEN lr.report_trade_count IS NOT NULL AND lr.report_trade_count > 0
        THEN 'report_trade_count_used_until_ops_signoff_field_exists'
      WHEN ac.assigned_trade_count IS NOT NULL AND ac.assigned_trade_count > 0
        THEN 'assignment_count_fallback'
      ELSE 'trade_count_missing'
    END AS expected_labour_status,
    lr.report_status,
    lr.report_trade_count,
    lr.report_labour_hours,
    ac.assigned_trade_count
  FROM public.jobs j
  LEFT JOIN public.makesafe_job_details mjd ON mjd.job_id = j.id
  LEFT JOIN public.makesafe_companies mc ON mc.id = mjd.requesting_company_id
  LEFT JOIN latest_report lr ON lr.job_id = j.id
  LEFT JOIN assignment_counts ac ON ac.job_id = j.id
  WHERE j.type = 'makesafe'
)
SELECT
  job_id,
  expected_min_hours_per_trade,
  expected_trade_count,
  CASE
    WHEN expected_trade_count IS NOT NULL
      THEN expected_min_hours_per_trade * expected_trade_count
    ELSE NULL
  END AS expected_labour_hours,
  expected_labour_source,
  expected_labour_status,
  report_status,
  report_trade_count,
  report_labour_hours,
  assigned_trade_count,
  CASE
    WHEN expected_trade_count IS NULL
      THEN 'Minimum hours per trade is known/defaulted, but expected trade count is not stamped yet.'
    ELSE 'Expected labour hours = min hours per trade × expected trade count. This is a baseline, not an actual cost.'
  END AS expected_labour_note
FROM base;

COMMENT ON VIEW public.v_makesafe_expected_labour IS
  'CP2 expected MakeSafe labour baseline. Advisory/source-labelled only; does not create cost lines, authorise payment, or write data.';

-- ------------------------------------------------------------
-- D. Main MakeSafe job-financial read model with honest flags.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.job_financials AS
WITH rev AS (
  SELECT
    r.resolved_job_id AS job_id,
    SUM(r.sub_total) FILTER (WHERE r.status IN ('AUTHORISED', 'PAID')) AS client_invoiced_ex,
    SUM(r.sub_total) FILTER (WHERE r.status = 'DRAFT') AS draft_revenue_ex,
    SUM(r.amount_paid / 1.1) FILTER (WHERE r.status IN ('AUTHORISED', 'PAID')) AS client_collected_ex,
    bool_or(NOT r.revenue_attributed_direct) FILTER (WHERE r.status IN ('AUTHORISED', 'PAID', 'DRAFT')) AS has_revenue_job_number_match,
    jsonb_agg(
      jsonb_build_object(
        'xero_invoice_row_id', r.xero_invoice_row_id,
        'xero_invoice_id', r.xero_invoice_id,
        'invoice_number', r.invoice_number,
        'status', r.status,
        'match_method', r.revenue_match_method,
        'sub_total', r.sub_total,
        'invoice_date', r.invoice_date
      )
      ORDER BY r.invoice_date NULLS LAST, r.created_at NULLS LAST
    ) FILTER (WHERE r.status IN ('AUTHORISED', 'PAID', 'DRAFT')) AS revenue_refs
  FROM public.v_job_revenue_resolved r
  WHERE r.resolved_job_id IS NOT NULL
  GROUP BY r.resolved_job_id
),
cost AS (
  SELECT
    r.resolved_job_id AS job_id,
    SUM(r.line_total_ex) FILTER (WHERE r.cost_lane = 'labour' AND NOT r.is_probable_test_line) AS cost_labour_ex,
    SUM(r.line_total_ex) FILTER (WHERE r.cost_lane = 'materials' AND NOT r.is_probable_test_line) AS cost_materials_ex,
    SUM(r.line_total_ex) FILTER (WHERE r.cost_lane = 'commission' AND NOT r.is_probable_test_line) AS cost_commission_ex,
    SUM(r.line_total_ex) FILTER (WHERE r.cost_lane IN ('other', 'unclassified') AND NOT r.is_probable_test_line) AS cost_other_ex,
    bool_or(r.cost_lane = 'labour' AND NOT r.is_probable_test_line) AS has_labour_line,
    bool_or(r.cost_lane = 'unclassified' AND NOT r.is_probable_test_line) AS has_unclassified,
    bool_or(r.match_method IN ('line_job_number', 'description_job_number') AND NOT r.is_probable_test_line) AS has_text_matched,
    bool_or(r.match_method = 'description_job_number' AND NOT r.is_probable_test_line) AS has_description_matched,
    bool_or(r.is_probable_test_line) AS has_excluded_test_lines,
    bool_or((c.zero_line OR c.mismatch) AND NOT r.is_probable_test_line) AS has_incomplete_invoice
  FROM public.v_trade_charge_resolved r
  LEFT JOIN public.v_invoice_line_completeness c ON c.trade_invoice_id = r.trade_invoice_id
  WHERE r.resolved_job_id IS NOT NULL
  GROUP BY r.resolved_job_id
),
assembled AS (
  SELECT
    j.id AS job_id,
    j.job_number,
    j.client_name,
    j.type AS job_type,
    j.status,
    j.created_at,
    COALESCE(rev.client_invoiced_ex, 0) AS client_invoiced_ex,
    COALESCE(rev.draft_revenue_ex, 0) AS draft_revenue_ex,
    COALESCE(rev.client_collected_ex, 0) AS client_collected_ex,
    COALESCE(cost.cost_labour_ex, 0) AS cost_labour_ex,
    COALESCE(cost.cost_materials_ex, 0) AS cost_materials_ex,
    COALESCE(cost.cost_commission_ex, 0) AS cost_commission_ex,
    0::numeric AS cost_card_fees_ex,
    COALESCE(cost.cost_other_ex, 0) AS cost_other_ex,
    0::numeric AS wo_allocation_declared_ex,
    exp.expected_min_hours_per_trade,
    exp.expected_trade_count,
    exp.expected_labour_hours,
    exp.expected_labour_source,
    exp.expected_labour_status,
    exp.expected_labour_note,
    COALESCE(rev.has_revenue_job_number_match, false) AS has_revenue_job_number_match,
    COALESCE(cost.has_labour_line, false) AS has_labour_line,
    COALESCE(cost.has_unclassified, false) AS has_unclassified,
    COALESCE(cost.has_text_matched, false) AS has_text_matched,
    COALESCE(cost.has_description_matched, false) AS has_description_matched,
    COALESCE(cost.has_excluded_test_lines, false) AS has_excluded_test_lines,
    COALESCE(cost.has_incomplete_invoice, false) AS has_incomplete_invoice,
    COALESCE(rev.revenue_refs, '[]'::jsonb) AS revenue_refs
  FROM public.jobs j
  LEFT JOIN rev ON rev.job_id = j.id
  LEFT JOIN cost ON cost.job_id = j.id
  LEFT JOIN public.v_makesafe_expected_labour exp ON exp.job_id = j.id
  WHERE j.org_id = '00000000-0000-0000-0000-000000000001'
    AND j.legacy = false
    AND j.status != 'cancelled'
    AND j.type = 'makesafe'
)
SELECT
  job_id,
  job_number,
  client_name,
  job_type,
  status,
  created_at,
  client_invoiced_ex,
  draft_revenue_ex,
  client_collected_ex,
  cost_labour_ex,
  cost_materials_ex,
  cost_commission_ex,
  cost_card_fees_ex,
  cost_other_ex,
  wo_allocation_declared_ex,
  CASE
    WHEN client_invoiced_ex = 0 THEN 'missing_client_invoice'
    WHEN has_revenue_job_number_match THEN 'job_number_matched_revenue'
    ELSE 'ok'
  END AS revenue_flag,
  CASE
    WHEN has_excluded_test_lines THEN 'test_lines_excluded'
    WHEN has_incomplete_invoice THEN 'incomplete_invoice_lines'
    WHEN has_unclassified THEN 'unclassified_lines'
    WHEN NOT has_labour_line THEN 'no_labour_linked'
    WHEN has_description_matched THEN 'description_matched_lines'
    WHEN has_text_matched THEN 'text_matched_lines'
    ELSE 'ok'
  END AS cost_flag,
  CASE
    WHEN client_invoiced_ex > 0
     AND has_labour_line
     AND NOT has_incomplete_invoice
     AND NOT has_unclassified
     AND NOT has_text_matched
     AND NOT has_excluded_test_lines
    THEN client_invoiced_ex
       - cost_labour_ex
       - cost_materials_ex
       - cost_commission_ex
       - cost_other_ex
    ELSE NULL
  END AS net_margin_ex,
  CASE
    WHEN client_invoiced_ex > 0
     AND has_labour_line
     AND NOT has_incomplete_invoice
     AND NOT has_unclassified
     AND NOT has_text_matched
     AND NOT has_excluded_test_lines
    THEN ROUND(((client_invoiced_ex - cost_labour_ex - cost_materials_ex - cost_commission_ex - cost_other_ex) / client_invoiced_ex) * 100, 1)
    ELSE NULL
  END AS margin_pct,
  expected_min_hours_per_trade,
  expected_trade_count,
  expected_labour_hours,
  expected_labour_source,
  expected_labour_status,
  expected_labour_note,
  array_remove(ARRAY[
    CASE WHEN client_invoiced_ex = 0 THEN 'missing_client_invoice' END,
    CASE WHEN has_revenue_job_number_match THEN 'revenue_job_number_matched' END,
    CASE WHEN NOT has_labour_line THEN 'no_labour_linked' END,
    CASE WHEN has_incomplete_invoice THEN 'incomplete_invoice_lines' END,
    CASE WHEN has_unclassified THEN 'unclassified_lines' END,
    CASE WHEN has_text_matched THEN 'text_matched_lines' END,
    CASE WHEN has_description_matched THEN 'description_matched_lines' END,
    CASE WHEN has_excluded_test_lines THEN 'test_lines_excluded' END,
    CASE WHEN expected_trade_count IS NULL THEN 'expected_trade_count_missing' END,
    CASE WHEN expected_labour_status IN ('report_trade_count_used_until_ops_signoff_field_exists', 'assignment_count_fallback', 'trade_count_missing') THEN expected_labour_status END,
    CASE WHEN cost_materials_ex = 0 THEN 'materials_not_captured_for_makesafe_v1' END
  ]::text[], NULL) AS data_quality_flags,
  revenue_refs,
  jsonb_build_object(
    'revenue', CASE
      WHEN client_invoiced_ex = 0 THEN 'missing'
      WHEN has_revenue_job_number_match THEN 'exact_job_number_match'
      ELSE 'direct_job_id'
    END,
    'labour', CASE
      WHEN has_labour_line AND NOT has_text_matched THEN 'direct_job_id'
      WHEN has_labour_line AND has_text_matched THEN 'matched_needs_review'
      ELSE 'missing'
    END,
    'expected_labour', expected_labour_status,
    'margin', CASE
      WHEN client_invoiced_ex > 0
       AND has_labour_line
       AND NOT has_incomplete_invoice
       AND NOT has_unclassified
       AND NOT has_text_matched
       AND NOT has_excluded_test_lines
      THEN 'trusted_v1_direct_non_test_costs'
      ELSE 'suppressed_until_flags_clear'
    END
  ) AS source_confidence
FROM assembled;

COMMENT ON VIEW public.job_financials IS
  'CP2 MakeSafe job-costing card. Margin is suppressed unless revenue and direct non-test labour cost are trustworthy. Adds expected-labour and data-quality flags for agents.';

-- ------------------------------------------------------------
-- E. Audit views read the same canonical resolver.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_makesafe_charge_ledger AS
SELECT
  j.job_number,
  j.client_name,
  u.name AS trade_name,
  r.week_start,
  r.xero_bill_id,
  r.cost_lane,
  r.line_total_ex,
  r.total_hours,
  r.line_date,
  r.attributed_direct,
  r.match_method,
  r.is_probable_test_line,
  r.exclusion_reason
FROM public.v_trade_charge_resolved r
JOIN public.jobs j ON j.id = r.resolved_job_id
JOIN public.users u ON u.id = r.user_id
WHERE j.type = 'makesafe'
   OR j.job_number ILIKE 'SWMS-%';

CREATE OR REPLACE VIEW public.v_job_double_charge AS
SELECT
  job_number,
  trade_name,
  COUNT(DISTINCT week_start) AS weeks_charged,
  SUM(line_total_ex) AS total_charged
FROM public.v_makesafe_charge_ledger
WHERE cost_lane = 'labour'
  AND NOT COALESCE(is_probable_test_line, false)
GROUP BY job_number, trade_name
HAVING COUNT(DISTINCT week_start) > 1;

-- ------------------------------------------------------------
-- F. Detail RPC: recreate because return type changes.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_job_financials(uuid);

CREATE OR REPLACE FUNCTION public.get_job_financials(p_job_id uuid)
RETURNS TABLE (
  job_id uuid,
  job_number text,
  client_name text,
  job_type text,
  status text,
  created_at timestamptz,
  client_invoiced_ex numeric,
  draft_revenue_ex numeric,
  client_collected_ex numeric,
  cost_labour_ex numeric,
  cost_materials_ex numeric,
  cost_commission_ex numeric,
  cost_card_fees_ex numeric,
  cost_other_ex numeric,
  wo_allocation_declared_ex numeric,
  revenue_flag text,
  cost_flag text,
  net_margin_ex numeric,
  margin_pct numeric,
  expected_min_hours_per_trade numeric,
  expected_trade_count int,
  expected_labour_hours numeric,
  expected_labour_source text,
  expected_labour_status text,
  expected_labour_note text,
  data_quality_flags text[],
  revenue_refs jsonb,
  source_confidence jsonb,
  lines jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    jf.job_id,
    jf.job_number,
    jf.client_name,
    jf.job_type,
    jf.status,
    jf.created_at,
    jf.client_invoiced_ex,
    jf.draft_revenue_ex,
    jf.client_collected_ex,
    jf.cost_labour_ex,
    jf.cost_materials_ex,
    jf.cost_commission_ex,
    jf.cost_card_fees_ex,
    jf.cost_other_ex,
    jf.wo_allocation_declared_ex,
    jf.revenue_flag,
    jf.cost_flag,
    jf.net_margin_ex,
    jf.margin_pct,
    jf.expected_min_hours_per_trade,
    jf.expected_trade_count,
    jf.expected_labour_hours,
    jf.expected_labour_source,
    jf.expected_labour_status,
    jf.expected_labour_note,
    jf.data_quality_flags,
    jf.revenue_refs,
    jf.source_confidence,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'line_id', r.line_id,
            'trade_invoice_id', r.trade_invoice_id,
            'user_id', r.user_id,
            'week_start', r.week_start,
            'cost_lane', r.cost_lane,
            'line_type', r.line_type,
            'description', r.description,
            'total_hours', r.total_hours,
            'hourly_rate', r.hourly_rate,
            'line_total_ex', r.line_total_ex,
            'line_date', r.line_date,
            'attributed_direct', r.attributed_direct,
            'match_method', r.match_method,
            'is_probable_test_line', r.is_probable_test_line,
            'excluded_from_margin', r.is_probable_test_line,
            'exclusion_reason', r.exclusion_reason,
            'invoice_status', r.invoice_status,
            'xero_bill_id', r.xero_bill_id
          )
          ORDER BY r.line_date NULLS LAST, r.week_start NULLS LAST
        )
        FROM public.v_trade_charge_resolved r
        WHERE r.resolved_job_id = p_job_id
      ),
      '[]'::jsonb
    ) AS lines
  FROM public.job_financials jf
  WHERE jf.job_id = p_job_id;
$$;

COMMENT ON FUNCTION public.get_job_financials(uuid) IS
  'CP2 agent-readable MakeSafe costing card: expected labour, actual cost/revenue, flags, source refs, confidence and line details. Read-only.';

-- ------------------------------------------------------------
-- G. Tighten public access for the read-model RPC/views. Edge ops-api uses
--    service_role, so anon/authenticated should not call this directly.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.get_job_financials(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_job_financials(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_job_financials(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_job_financials(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_job_financials(uuid) TO postgres;

REVOKE ALL ON public.v_job_revenue_resolved FROM anon, authenticated;
REVOKE ALL ON public.v_trade_charge_resolved FROM anon, authenticated;
REVOKE ALL ON public.v_makesafe_expected_labour FROM anon, authenticated;
REVOKE ALL ON public.job_financials FROM anon, authenticated;
REVOKE ALL ON public.v_makesafe_charge_ledger FROM anon, authenticated;
REVOKE ALL ON public.v_job_double_charge FROM anon, authenticated;

GRANT SELECT ON public.v_job_revenue_resolved TO service_role, postgres;
GRANT SELECT ON public.v_trade_charge_resolved TO service_role, postgres;
GRANT SELECT ON public.v_makesafe_expected_labour TO service_role, postgres;
GRANT SELECT ON public.job_financials TO service_role, postgres;
GRANT SELECT ON public.v_makesafe_charge_ledger TO service_role, postgres;
GRANT SELECT ON public.v_job_double_charge TO service_role, postgres;
