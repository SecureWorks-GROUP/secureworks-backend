-- Live changes nobody read: the transcript_capture block already replaced by
-- some other body, a ghl-call-transcript-fetch cron job with another command,
-- and a jobs status list without one of the live statuses the history load
-- names. The guard must refuse and name all three.
CREATE OR REPLACE FUNCTION public.context_transcript_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT '{"alarms":[]}'::jsonb $$;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY,schedule text NOT NULL,command text NOT NULL,active boolean NOT NULL DEFAULT true,jobname text);
INSERT INTO cron.job(jobname,schedule,command) VALUES('ghl-call-transcript-fetch','*/5 * * * *','SELECT 1');
ALTER TABLE public.jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('draft','quoted','accepted','scheduled','in_progress')) NOT VALID;
