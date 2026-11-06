-- After the down: the three objects 20261104235000 added are gone, nothing it read changed, and Job Profit still reads.
DO $$
BEGIN
  IF to_regclass('public.v_job_profit_xero_basis_lines') IS NOT NULL OR to_regclass('public.v_job_profit_division_months') IS NOT NULL
     OR to_regprocedure('public.job_profit_job_division(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'A3 Xero basis rollback: an object 20261104235000 added is still there';
  END IF;
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> 'b48997c55913ce3c90e3a3c947533fd3' THEN
    RAISE EXCEPTION 'A3 Xero basis rollback: v_job_cost_events changed (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
  PERFORM count(*) FROM public.v_job_profit;
  PERFORM count(*) FROM public.v_job_revenue_events;
END $$;
