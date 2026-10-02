-- T2 setup: every table and function this migration reads already exists in
-- the earlier registered fixtures (business_events, jobs, job_documents,
-- quote_revisions, feature_flags, context_capture_runs, automation_switches).
-- No row is seeded: production has no ghl_call_transcript_fetch_v1 row and no
-- call_transcript_fetches table (read 24 Sep 2026).
-- A check that the fixtures leave exactly production's pre-image of the two
-- functions this migration replaces.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_transcript_capture_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 't2 setup: context_transcript_capture_status is not the production F1b stub'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM '459035de5d3f7f7af49c36f09d9be29e'
 THEN RAISE EXCEPTION 't2 setup: automation_switch_cron_lanes is not the production body'; END IF;
END $$;
