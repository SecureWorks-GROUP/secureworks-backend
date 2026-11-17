DO $check$ BEGIN
 IF to_regprocedure('public.job_profit_refresh_all(uuid,integer)') IS NOT NULL
  OR position('LOOP' IN pg_get_functiondef('public.job_profit_refresh_all()'::regprocedure))=0
  OR position('job_profit_refresh_cost' IN pg_get_functiondef('public.job_profit_refresh_many(uuid[])'::regprocedure))<>0 THEN
  RAISE EXCEPTION 'FU21 rollback did not restore the two main bodies'; END IF;
END $check$;
