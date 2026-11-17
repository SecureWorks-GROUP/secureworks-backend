-- Earlier registered migrations supply the full views. Stand-ins support an
-- isolated disposable case too; never replace an existing view in setup.
DO $setup$ BEGIN
 IF to_regclass('public.v_job_profit') IS NULL THEN
  EXECUTE 'CREATE VIEW public.v_job_profit AS SELECT NULL::uuid job_id,NULL::text job_number,NULL::numeric profit_ex WHERE false';
 END IF;
 IF to_regclass('public.v_job_cost_events') IS NULL THEN
  EXECUTE 'CREATE VIEW public.v_job_cost_events AS SELECT NULL::uuid job_id,NULL::numeric amount_ex WHERE false';
 END IF;
 IF to_regclass('public.v_job_revenue_events') IS NULL THEN
  EXECUTE 'CREATE VIEW public.v_job_revenue_events AS SELECT NULL::uuid job_id,NULL::numeric amount_ex WHERE false';
 END IF;
END $setup$;
