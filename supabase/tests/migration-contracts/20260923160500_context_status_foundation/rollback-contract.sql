-- After the F1 down migration: the 17 Sep heartbeat, statuses, custody writer
-- and current-facts view are back, and every F1 object is gone.
DO $$
DECLARE snap jsonb; f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_linked_status(text)','public.context_unplaced_for_job(uuid)','public.context_source_freshness()',
  'public.context_source_freshness_policy()','public.context_in_business_hours(timestamptz)','public.context_business_minutes(timestamptz,timestamptz)',
  'public.context_core_status()','public.context_cadence_status()','public.context_ghl_capture_status()',
  'public.context_booking_capture_status()','public.context_parties_status()','public.record_capture_run(jsonb)'] LOOP
  IF to_regprocedure(f) IS NOT NULL THEN RAISE EXCEPTION 'f1 rollback left %',f; END IF;
 END LOOP;
 IF to_regclass('public.context_capture_runs') IS NOT NULL THEN RAISE EXCEPTION 'f1 rollback left context_capture_runs'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.business_events'::regclass AND attname='candidate_job_ids' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'f1 rollback left candidate_job_ids'; END IF;
 IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='business_events_attribution_status_check')) LIKE '%unplaced%'
 THEN RAISE EXCEPTION 'f1 rollback left the wide status check'; END IF;
 IF pg_get_functiondef('public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)'::regprocedure) NOT LIKE
   '%NOT IN (''direct'',''thread'',''single_open'',''single_line'',''luna'')%'
  OR pg_get_viewdef('public.current_job_context_facts'::regclass) LIKE '%context_linked_status%'
 THEN RAISE EXCEPTION 'f1 rollback did not restore Luna custody'; END IF;
 snap:=public.context_pipeline_status();
 IF snap ? 'alarms' OR snap ? 'capture_sources' OR snap->'coverage' IS NULL OR snap->>'run_date' IS NULL
 THEN RAISE EXCEPTION 'f1 rollback heartbeat shape %',snap; END IF;
 IF has_function_privilege('anon','public.context_pipeline_status()','EXECUTE') OR NOT has_function_privilege('service_role','public.context_pipeline_status()','EXECUTE')
 THEN RAISE EXCEPTION 'f1 rollback heartbeat grants'; END IF;
END $$;
