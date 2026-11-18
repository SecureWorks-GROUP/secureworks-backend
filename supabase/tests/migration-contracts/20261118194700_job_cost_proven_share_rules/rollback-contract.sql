-- After the down migration: 20261118124326's exact two bodies and privileges are back.
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = to_regprocedure('public.job_cost_proven_share(uuid[])'))
     IS DISTINCT FROM '317bbcbdc920b45a9752ba25d07d413f' THEN
    RAISE EXCEPTION 'ZZTEST rollback did not restore 20261118124326 job_cost_proven_share body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = to_regprocedure('public.job_profit_store_proven_share(uuid[])'))
     IS DISTINCT FROM '72a8fbd89744351d172f7552d2bc7d3f' THEN
    RAISE EXCEPTION 'ZZTEST rollback did not restore 20261118124326 job_profit_store_proven_share body';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.job_cost_proven_share(uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.job_cost_proven_share(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.job_cost_proven_share(uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.job_profit_store_proven_share(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST rollback changed proven-share execute privileges';
  END IF;
END $$;
\echo PASS P2-13.2 follow-up rollback restores 20261118124326 bodies and privileges
