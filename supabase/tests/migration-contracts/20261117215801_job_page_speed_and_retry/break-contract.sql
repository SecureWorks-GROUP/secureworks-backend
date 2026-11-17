-- Remove both yield calls, keeping all existing guards and write paths.
DO $break$ BEGIN
 EXECUTE replace(pg_get_functiondef('public.job_page_refresh(uuid)'::regprocedure),
  'PERFORM public.job_page_yield(p_job_id);','');
END $break$;
