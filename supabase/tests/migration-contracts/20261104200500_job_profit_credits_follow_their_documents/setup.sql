-- Prerequisites for 20261104200500 (Job Profit, finish-line row A2): the line evidence rule and v_job_profit as the
-- stack builds them (20261104093000 and 20261104110000 setups and migrations), v_job_revenue_events and
-- xero_projects. Nothing is created here.
DO $$
BEGIN
  IF to_regprocedure('public.job_profit_line_evidence_many(uuid[])') IS NULL
     OR to_regprocedure('public.job_profit_line_evidence_score(date,date)') IS NULL
     OR to_regclass('public.v_job_profit') IS NULL OR to_regclass('public.v_job_cost_events') IS NULL
     OR to_regclass('public.v_job_revenue_events') IS NULL OR to_regclass('public.xero_projects') IS NULL THEN
    RAISE EXCEPTION 'A2 credits prerequisites missing: the line evidence rule, Job Profit, revenue events or Xero projects';
  END IF;
END $$;
