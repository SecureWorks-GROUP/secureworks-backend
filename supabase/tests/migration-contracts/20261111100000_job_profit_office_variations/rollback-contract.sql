-- After the down: both views are back to their exact earlier definitions and still read; job_profit(uuid) reads.
SET TimeZone = 'UTC';
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '1ac286e983426f43c67f94fd84268e07' THEN
    RAISE EXCEPTION 'RQ-15.g rollback: v_job_profit is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) NOT IN ('2191799f0f51ef34b5fe90879e8387cb', '18c6f924719d2c53ca537e8d58d7555f') THEN
    RAISE EXCEPTION 'RQ-15.g rollback: v_job_revenue_events is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true));
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'v_job_profit'
              AND column_name LIKE '%office_variation%') THEN
    RAISE EXCEPTION 'RQ-15.g rollback: v_job_profit still has the office variation columns';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT')
     OR NOT has_function_privilege('service_role', 'public.job_profit(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RQ-15.g rollback: a grant was lost';
  END IF;
  PERFORM count(*) FROM public.v_job_revenue_events;
  PERFORM count(*) FROM public.v_job_profit;
  PERFORM * FROM public.job_profit(gen_random_uuid());
END $$;
