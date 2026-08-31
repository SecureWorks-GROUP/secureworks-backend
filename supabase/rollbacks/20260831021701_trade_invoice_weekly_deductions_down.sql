-- Roll back weekly work-order trade-invoice metadata. Existing invoice rows are
-- preserved; applying this rollback requires first removing any new-shape data.

DROP FUNCTION IF EXISTS public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid);
DROP FUNCTION IF EXISTS public.persist_trade_work_order_invoice_v1(jsonb, jsonb, uuid);

ALTER TABLE public.trade_invoice_lines
  DROP CONSTRAINT IF EXISTS trade_invoice_lines_source_work_order_fk,
  DROP CONSTRAINT IF EXISTS trade_invoice_lines_source_trade_line_fk,
  DROP CONSTRAINT IF EXISTS trade_invoice_lines_deduction_user_fk,
  DROP CONSTRAINT IF EXISTS trade_invoice_lines_deduction_assignment_fk,
  DROP CONSTRAINT IF EXISTS trade_invoice_lines_deduction_trade_rate_fk,
  DROP CONSTRAINT IF EXISTS trade_invoice_lines_typed_deduction_sign_check,
  DROP CONSTRAINT IF EXISTS trade_invoice_lines_final_deduction_scope_check,
  DROP CONSTRAINT IF EXISTS trade_invoice_lines_line_position_check;

DROP INDEX IF EXISTS public.idx_trade_invoice_lines_source_work_order;
DROP INDEX IF EXISTS public.idx_trade_invoice_lines_source_trade_line;
DROP INDEX IF EXISTS public.idx_trade_invoice_lines_deduction_user;
DROP INDEX IF EXISTS public.idx_trade_invoice_lines_deduction_assignment;
DROP INDEX IF EXISTS public.idx_trade_invoice_lines_deduction_trade_rate;

ALTER TABLE public.trade_invoice_lines
  DROP COLUMN IF EXISTS source_work_order_id,
  DROP COLUMN IF EXISTS source_trade_invoice_line_id,
  DROP COLUMN IF EXISTS deduction_user_id,
  DROP COLUMN IF EXISTS deduction_assignment_id,
  DROP COLUMN IF EXISTS deduction_trade_rate_id,
  DROP COLUMN IF EXISTS site_address,
  DROP COLUMN IF EXISTS line_position;

ALTER TABLE public.trade_invoices
  DROP CONSTRAINT IF EXISTS trade_invoices_weekly_totals_check,
  DROP COLUMN IF EXISTS job_grand_total_ex,
  DROP COLUMN IF EXISTS final_deductions_total_ex,
  DROP COLUMN IF EXISTS to_be_paid_ex;

ALTER TABLE public.trade_invoices
  DROP CONSTRAINT IF EXISTS trade_invoices_invoice_source_check;
ALTER TABLE public.trade_invoices
  ADD CONSTRAINT trade_invoices_invoice_source_check CHECK (
    invoice_source IN ('hourly', 'work_order', 'per_metre', 'misc')
  );

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
    WHEN lb.line_type IN ('labour', 'fencing', 'patio', 'make safe', 'general labour') THEN 'labour'
    WHEN lb.line_type = 'materials' THEN 'materials'
    WHEN lb.line_type = 'commission' THEN 'commission'
    WHEN lb.line_type IN ('travel', 'equipment', 'other') THEN 'other'
    ELSE 'unclassified'
  END AS cost_lane,
  CASE
    WHEN j_direct.id IS NOT NULL THEN 'job_id'
    WHEN j_line.id IS NOT NULL THEN 'line_job_number'
    WHEN j_desc.id IS NOT NULL THEN 'description_job_number'
    ELSE 'unresolved'
  END AS match_method,
  lb.is_probable_test_line,
  CASE WHEN lb.is_probable_test_line THEN 'qa_or_delete_test_line' ELSE NULL END AS exclusion_reason,
  lb.flag_type,
  lb.baseline_hours,
  lb.baseline_source,
  lb.hours_justification,
  lb.flagged_at,
  (lb.flag_type IS NOT NULL) AS is_hours_flagged
FROM line_base lb
JOIN public.trade_invoices ti ON ti.id = lb.trade_invoice_id
LEFT JOIN public.jobs j_direct
  ON j_direct.id = lb.job_id AND j_direct.org_id = ti.org_id
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
  'CP2 canonical trade-cost resolver + M4 U4 hours-flag facts.';
REVOKE ALL ON public.v_trade_charge_resolved FROM anon, authenticated;
GRANT SELECT ON public.v_trade_charge_resolved TO service_role, postgres;
