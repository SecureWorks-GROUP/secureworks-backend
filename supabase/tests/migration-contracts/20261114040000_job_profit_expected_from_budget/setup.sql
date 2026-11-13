-- Prerequisites for 20261114040000_job_profit_expected_from_budget: the job budget tables (20261113190000) and
-- v_job_profit as 20261111100000 left it, applied by the registered walk. This case adds nothing.
DO $$
BEGIN
  IF to_regclass('public.job_budgets') IS NULL THEN
    RAISE EXCEPTION 'R17 step 5: 20261113190000 is not applied before 20261114040000';
  END IF;
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> 'ef8c3682ff4da148ffe42635eb404abe' THEN
    RAISE EXCEPTION 'R17 step 5: v_job_profit is not 20261111100000''s definition before 20261114040000';
  END IF;
END $$;
