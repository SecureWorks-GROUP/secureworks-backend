-- After the C1d rollback: the F1 stub is back (null block, F1 comment), the lane
-- list is the two production rows, the added functions are gone, and the
-- composer still answers with ghl_capture null.
DO $$
BEGIN
 IF public.context_ghl_capture_status() IS NOT NULL THEN RAISE EXCEPTION 'c1d rollback: stub not restored'; END IF;
 IF obj_description('public.context_ghl_capture_status()'::regprocedure,'pg_proc') NOT LIKE 'F1 stub.%' THEN RAISE EXCEPTION 'c1d rollback: stub comment'; END IF;
 IF has_function_privilege('anon','public.context_ghl_capture_status()','EXECUTE') THEN RAISE EXCEPTION 'c1d rollback: stub grants'; END IF;
 IF (SELECT count(*) FROM public.automation_switch_cron_lanes())<>2 THEN RAISE EXCEPTION 'c1d rollback: lane list'; END IF;
 IF to_regprocedure('public.trigger_ghl_message_reconcile()') IS NOT NULL OR to_regprocedure('public.context_ghl_item_flag()') IS NOT NULL
  OR to_regprocedure('public.context_ghl_capture_policy()') IS NOT NULL THEN RAISE EXCEPTION 'c1d rollback: functions left behind'; END IF;
 IF public.context_pipeline_status()->'ghl_capture'<>'null'::jsonb THEN RAISE EXCEPTION 'c1d rollback: composer block'; END IF;
END $$;
