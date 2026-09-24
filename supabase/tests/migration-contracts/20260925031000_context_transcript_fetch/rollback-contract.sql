-- After the T2 rollback: the F1b stub is back (null block, F1b comment, service
-- role only), the lane list is C1d's three rows, the added functions and the
-- fetch records table are gone, and the composer answers transcript_capture null.
DO $$
BEGIN
 IF public.context_transcript_capture_status() IS NOT NULL THEN RAISE EXCEPTION 't2 rollback: stub not restored'; END IF;
 IF obj_description('public.context_transcript_capture_status()'::regprocedure,'pg_proc') NOT LIKE 'F1b stub.%' THEN RAISE EXCEPTION 't2 rollback: stub comment'; END IF;
 IF has_function_privilege('anon','public.context_transcript_capture_status()','EXECUTE') THEN RAISE EXCEPTION 't2 rollback: stub grants'; END IF;
 IF (SELECT array_agg(cron_jobname ORDER BY cron_jobname) FROM public.automation_switch_cron_lanes())
    IS DISTINCT FROM ARRAY['contact-matching','ghl-message-reconcile','monitor-inbox-poll'] THEN RAISE EXCEPTION 't2 rollback: lane list'; END IF;
 IF to_regclass('public.call_transcript_fetches') IS NOT NULL
  OR to_regprocedure('public.trigger_ghl_call_transcript_fetch()') IS NOT NULL
  OR to_regprocedure('public.record_call_transcript_fetch(jsonb)') IS NOT NULL
  OR to_regprocedure('public.context_transcript_due_calls(integer)') IS NOT NULL
  OR to_regprocedure('public.context_transcript_backfill_contacts(text,integer)') IS NOT NULL
  OR to_regprocedure('public.context_call_transcript_eligible(text,text,jsonb)') IS NOT NULL
  OR to_regprocedure('public.context_transcript_fetch_flag()') IS NOT NULL
  OR to_regprocedure('public.context_transcript_capture_policy()') IS NOT NULL
 THEN RAISE EXCEPTION 't2 rollback: objects left behind'; END IF;
 IF public.context_pipeline_status()->'transcript_capture'<>'null'::jsonb THEN RAISE EXCEPTION 't2 rollback: composer block'; END IF;
END $$;
