-- After the F-ACT rollback: F1's core body is back (md5 checked by the down
-- file too), the counter and both functions are gone, and the heartbeat
-- answers with no actor_missing key and every other key as before.
DO $$
DECLARE composed jsonb;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_core_status()')) IS DISTINCT FROM '3df30c5ccf6db32c4782ba7859591b86'
 THEN RAISE EXCEPTION 'f-act rollback: core body'; END IF;
 IF to_regclass('public.ops_api_actor_calls') IS NOT NULL OR to_regprocedure('public.record_ops_api_actor_missing()') IS NOT NULL
  OR to_regprocedure('public.context_actor_missing_status()') IS NOT NULL
 THEN RAISE EXCEPTION 'f-act rollback: objects left behind'; END IF;
 composed:=public.context_pipeline_status();
 IF composed ? 'actor_missing' OR composed->'run_date' IS NULL OR NOT composed ? 'coverage' THEN RAISE EXCEPTION 'f-act rollback: heartbeat %',composed; END IF;
 IF has_function_privilege('anon','public.context_core_status()','EXECUTE') OR NOT has_function_privilege('service_role','public.context_core_status()','EXECUTE')
 THEN RAISE EXCEPTION 'f-act rollback: grants'; END IF;
END $$;
