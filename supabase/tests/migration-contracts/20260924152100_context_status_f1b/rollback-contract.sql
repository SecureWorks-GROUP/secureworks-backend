-- After the F1b rollback: F1's four bodies are back (md5 checked by the down
-- file itself), the stubs and window_end_id are gone, the composer answers
-- with F1's keys only, record_capture_run refuses window_end_id as an unknown
-- key, and transcribe-call is judged by F1's rule again.
DO $$
DECLARE composed jsonb;
BEGIN
 IF to_regprocedure('public.context_email_capture_status()') IS NOT NULL OR to_regprocedure('public.context_transcript_capture_status()') IS NOT NULL
  OR to_regprocedure('public.context_money_status()') IS NOT NULL OR to_regprocedure('public.context_bucket_status()') IS NOT NULL
 THEN RAISE EXCEPTION 'f1b rollback: stubs left behind'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_capture_runs'::regclass AND attname='window_end_id' AND NOT attisdropped)
  OR EXISTS(SELECT 1 FROM pg_constraint WHERE conname='context_capture_runs_window_end_id')
 THEN RAISE EXCEPTION 'f1b rollback: window_end_id left behind'; END IF;
 composed:=public.context_pipeline_status();
 IF composed ?| ARRAY['email_capture','transcript_capture','money','bucket'] OR NOT composed ?& ARRAY['cadence','capture_sources','ghl_capture','booking_capture','parties','alarms']
 THEN RAISE EXCEPTION 'f1b rollback: composer keys %',(SELECT array_agg(k) FROM jsonb_object_keys(composed) k); END IF;
 IF public.context_source_freshness_policy() ?| ARRAY['retired_sources','flag_gated_sources'] THEN RAISE EXCEPTION 'f1b rollback: policy'; END IF;
 BEGIN
  PERFORM public.record_capture_run('{"source":"outlook_cursor_test","window_to":"2026-09-23T02:14:00Z","window_end_id":"AAMkAGa0001"}');
  RAISE EXCEPTION 'f1b rollback: F1 writer accepted window_end_id' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'capture_run_invalid' THEN RAISE; END IF; END;
 IF has_function_privilege('anon','public.context_pipeline_status()','EXECUTE') OR has_function_privilege('anon','public.record_capture_run(jsonb)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_source_freshness()','EXECUTE')
 THEN RAISE EXCEPTION 'f1b rollback: grants'; END IF;
END $$;
