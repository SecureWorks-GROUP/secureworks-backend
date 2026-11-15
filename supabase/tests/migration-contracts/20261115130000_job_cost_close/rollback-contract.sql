-- After the down: both functions are gone, Job Profit is untouched and still answers, a second run of the down
-- is a no-op, and the migration applies again on top of it.
DO $$
BEGIN
  IF to_regprocedure('public.job_cost_close(uuid[],date)') IS NOT NULL
     OR to_regprocedure('public.job_cost_close_policy()') IS NOT NULL THEN
    RAISE EXCEPTION 'job cost close rollback: a function is still there';
  END IF;
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '578270db501761330fad0b46412aac95' THEN
    RAISE EXCEPTION 'job cost close rollback: v_job_profit changed';
  END IF;
  PERFORM count(*) FROM public.v_job_profit;
END $$;

\ir ../../../rollbacks/20261115130000_job_cost_close_down.sql

DO $$
BEGIN
  IF to_regprocedure('public.job_cost_close(uuid[],date)') IS NOT NULL THEN
    RAISE EXCEPTION 'job cost close rollback: a second run of the down left a function';
  END IF;
END $$;

\ir ../../../migrations/20261115130000_job_cost_close.sql

DO $$
BEGIN
  IF to_regprocedure('public.job_cost_close(uuid[],date)') IS NULL
     OR (public.job_cost_close_policy() ->> 'quiet_days')::int <> 30 THEN
    RAISE EXCEPTION 'job cost close rollback: the migration did not apply again';
  END IF;
  IF has_function_privilege('anon', 'public.job_cost_close(uuid[],date)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.job_cost_close(uuid[],date)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'job cost close rollback: the grants are not the service role only after the second apply';
  END IF;
END $$;
