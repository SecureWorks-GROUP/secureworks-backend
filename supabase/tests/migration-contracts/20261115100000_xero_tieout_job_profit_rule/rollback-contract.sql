-- After the down: the tie-out is 20261030060000's again, byte for byte, with its comment and grants; a second run of
-- the down is a no-op; and the migration applies again on top of it.
DO $$
DECLARE fn regprocedure := 'public.xero_tieout_monthly(date,integer,uuid)'::regprocedure;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = fn) <> 'e0d6ef30a46cd98dd8c5fc67b46ca1ef'
     OR obj_description(fn, 'pg_proc') NOT LIKE 'TP-01 Xero tie-out (20261029121500), supplier credit notes TP-07 (20261030060000): %' THEN
    RAISE EXCEPTION 'xero tie-out job profit rule rollback: the tie-out is not 20261030060000''s';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = fn) LIKE '%v_job_cost_events%' THEN
    RAISE EXCEPTION 'xero tie-out job profit rule rollback: the restored tie-out still reads the cost view';
  END IF;
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'xero tie-out job profit rule rollback: the grants are not the service role only';
  END IF;
  IF public.xero_tieout_monthly('2034-03-15', 1, NULL) -> 'months' -> 0 ->> 'month' <> '2034-03' THEN
    RAISE EXCEPTION 'xero tie-out job profit rule rollback: the restored tie-out does not answer';
  END IF;
END $$;

\ir ../../../rollbacks/20261115100000_xero_tieout_job_profit_rule_down.sql

DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.xero_tieout_monthly(date,integer,uuid)'::regprocedure) <> 'e0d6ef30a46cd98dd8c5fc67b46ca1ef' THEN
    RAISE EXCEPTION 'xero tie-out job profit rule rollback: a second run of the down changed the function';
  END IF;
END $$;

\ir ../../../migrations/20261115100000_xero_tieout_job_profit_rule.sql

DO $$
BEGIN
  IF obj_description('public.xero_tieout_monthly(date,integer,uuid)'::regprocedure, 'pg_proc') NOT LIKE 'TP-01 Xero tie-out, Job Profit rule (20261115100000%' THEN
    RAISE EXCEPTION 'xero tie-out job profit rule rollback: the migration did not apply again after its down';
  END IF;
END $$;
