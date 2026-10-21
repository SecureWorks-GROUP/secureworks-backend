-- Roll back 20261015093000_trade_charge_work_order_labour.
--
-- Restores the previous lanes: 'work order' and 'work_order' pay lines go back
-- to cost_lane 'unclassified'. Output columns are unchanged either way, so
-- dependent views stay bound. line_base keeps the named-column form so this
-- rollback adds no whole-row dependency on trade_invoice_lines.

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
    WHEN lb.line_type IN (
      'labour', 'fencing', 'patio', 'make safe', 'general labour',
      'crew_work_order_deduction', 'labour_deduction'
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
  'Canonical trade-cost resolver with hours-flag facts and weekly typed deduction lanes. Final payout deductions stay non-job/unresolved.';

REVOKE ALL ON public.v_trade_charge_resolved FROM anon, authenticated;
GRANT SELECT ON public.v_trade_charge_resolved TO service_role, postgres;
