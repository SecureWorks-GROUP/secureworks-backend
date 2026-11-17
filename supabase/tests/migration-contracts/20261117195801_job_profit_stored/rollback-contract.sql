DO $check$ BEGIN
 IF to_regclass('public.job_profit_stored') IS NOT NULL OR to_regclass('public.job_cost_events_stored') IS NOT NULL OR to_regclass('public.job_revenue_events_stored') IS NOT NULL OR to_regclass('public.job_profit_dirty') IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_stored_read_v1')
 OR to_regprocedure('public.job_profit_refresh_many(uuid[])') IS NOT NULL THEN
  RAISE EXCEPTION 'stored profit rollback left additive state';
 END IF;
 IF to_regclass('public.v_job_profit') IS NULL OR to_regclass('public.v_job_cost_events') IS NULL OR to_regclass('public.v_job_revenue_events') IS NULL THEN
  RAISE EXCEPTION 'stored profit rollback removed legacy views';
 END IF;
END $check$;
SELECT 'PASS: stored profit rollback preserves the original views' AS result;
