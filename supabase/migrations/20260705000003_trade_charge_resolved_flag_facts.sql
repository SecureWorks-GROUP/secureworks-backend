-- Make-safe hours-flag facts ride the canonical trade-charge lane (M4 U4).
--
-- Mission profit-trade-invoice-intelligence-2026-07-03 (campaign
-- profitability-job-costing, M4). Wiki issue #112. U1
-- (20260705000002_trade_invoice_line_hours_flag.sql) LANDED the per-line flag
-- facts on trade_invoice_lines (flag_type, baseline_hours, baseline_source,
-- hours_justification, flagged_at). U4 surfaces them AS ATTRIBUTES of the
-- resolved labour charge by extending public.v_trade_charge_resolved — the
-- canonical cost lane that job_financials already reads and that M3's
-- v_job_money_facts will read. Because the flags travel on this one lane, the
-- U5 finance cost report and the M5/M6 consumers read them per job with a
-- single join key (resolved_job_id); no new resolution logic is duplicated.
--
-- This is a PURE, ADDITIVE column extension: the view's existing columns keep
-- their names, types and order, and the five flag columns plus a convenience
-- boolean are appended at the end. That is exactly what CREATE OR REPLACE VIEW
-- permits, so dependent views/functions (job_financials, v_makesafe_charge_ledger,
-- v_job_double_charge, get_job_financial_detail) are untouched and keep working.
-- The definition below is reproduced verbatim from the current canonical
-- source, 20260619053037_cp2_makesafe_job_financial_readability.sql, with only
-- the appended block added.
--
-- Builder/client invoice amounts NEVER feed these facts (2026-06-19 ruling).
-- The view still changes no $/hours/rates — it annotates only.
--
-- HAND-APPLIED: applied manually by the orchestrator in the same gated batch as
-- U1's column migration (after CP2 + Marnin approval), not by CI auto-migrate.
-- Idempotent (CREATE OR REPLACE); safe to re-run.

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
  END AS exclusion_reason,
  -- ── M4 U4: make-safe hours-flag facts (appended; CREATE OR REPLACE-safe) ──
  -- U1 writes these onto trade_invoice_lines; here they surface as attributes
  -- of the resolved labour charge so downstream reads them by resolved_job_id.
  lb.flag_type,             -- 'hours_over_baseline' when flagged, else NULL
  lb.baseline_hours,        -- resolved allowed hours (set for every make-safe line)
  lb.baseline_source,       -- 'ops_set' | 'report' | 'rule_default'
  lb.hours_justification,   -- trade's variation explanation (U2 capture)
  lb.flagged_at,            -- when the line was flagged, else NULL
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
  'CP2 canonical trade-cost resolver + M4 U4 hours-flag facts. Direct and job-number fallbacks are scoped by trade invoice org_id; probable QA/test lines are excluded from trusted aggregates downstream. flag_type/baseline_hours/baseline_source/hours_justification/flagged_at/is_hours_flagged surface the make-safe over-allowance flag per resolved_job_id for the U5 finance cost report, the U3 email, and M3 v_job_money_facts / M5-M6.';

-- Grants unchanged from the CP2 definition (service-role/postgres only; the view
-- carries cost data and is never exposed to anon/authenticated directly).
REVOKE ALL ON public.v_trade_charge_resolved FROM anon, authenticated;
GRANT SELECT ON public.v_trade_charge_resolved TO service_role, postgres;
