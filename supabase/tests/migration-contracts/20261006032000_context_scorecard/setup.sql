-- Prerequisites for 20261006032000_context_scorecard: nothing new. Every table
-- and function the scorecard reads is created by an earlier registered case
-- (the status functions, the capture runs, the unread definition, the misfile
-- rows, the record layer and the story scorecard of 20261006011000 and
-- 20261006014000). This check fails early, and by name, if one is missing.
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_source_freshness()','public.context_email_capture_status()',
   'public.context_ghl_capture_status()','public.context_transcript_capture_status()','public.context_document_text_status()',
   'public.context_document_vision_status()','public.context_ghl_history_progress()','public.context_email_history_status()',
   'public.context_unread_rows(uuid[])','public.context_payload_job_mismatch_rows()',
   'public.context_business_minutes(timestamptz,timestamptz)','public.context_job_record_timeline(uuid[],timestamptz)',
   'public.context_story_scorecard_jobs(uuid,integer)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'scorecard setup: % is missing from the registered stack', f; END IF;
 END LOOP;
END $$;
