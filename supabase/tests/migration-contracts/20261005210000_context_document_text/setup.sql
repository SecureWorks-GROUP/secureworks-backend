-- B-5 setup: every table and function this migration reads already exists in
-- the earlier registered fixtures (business_events, jobs, job_documents,
-- context_email_attachments, feature_flags, context_capture_runs,
-- automation_switches, the ladder, M4's live-job definition) except
-- job_documents.pdf_url: a live production column since the first schema
-- (20250301000001) that the earlier fixtures never needed.
ALTER TABLE public.job_documents ADD COLUMN IF NOT EXISTS pdf_url text;
-- A check that the fixtures leave exactly production's pre-image of the one
-- function this migration replaces (the email reader body, 20261002150000).
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM '5c1e0e526a74d5b4ad612792c7f076cc'
 THEN RAISE EXCEPTION 'b5 setup: automation_switch_cron_lanes is not the email reader body'; END IF;
END $$;
