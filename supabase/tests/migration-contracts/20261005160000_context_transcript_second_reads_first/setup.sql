-- T2b setup: no prerequisites. business_events, call_transcript_fetches and
-- T2's context_transcript_due_calls come from earlier registered cases. A
-- check that the stack leaves T2's body, the pre-image this migration replaces.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_transcript_due_calls(integer,boolean)')) IS DISTINCT FROM '74d87e872300c883676c6ed8a3188023'
 THEN RAISE EXCEPTION 't2b setup: context_transcript_due_calls is not T2''s body'; END IF;
END $$;
