-- Remove one promise: v_job_profit takes a sealed patio revision that states no labour as the expected cost even
-- while crew labour is on the job (the 20261104080000 behaviour). The contract must catch it on A6P-LAB.
DO $$
DECLARE
  v_def text;
BEGIN
  SET LOCAL TimeZone = 'UTC';
  v_def := pg_get_viewdef('public.v_job_profit'::regclass, true);
  v_def := replace(v_def, ' AND (COALESCE(job_profit_num(fz.pj -> ''labourCostEstimate''::text), 0::numeric) > 0::numeric OR COALESCE(cost.labour_ex, 0::numeric) <= 0::numeric)', '');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || v_def;
END $$;
