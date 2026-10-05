-- Live changes nobody read: the lane list already replaced by some other
-- body, a context-document-text cron job with another command, and M4's
-- live-job definition changed under the reader. The guard must refuse and
-- name all three.
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text) LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $fn$ SELECT * FROM (VALUES ('monitor-inbox-poll', 'capture')) AS t(cron_jobname, lane); $fn$;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY,schedule text NOT NULL,command text NOT NULL,active boolean NOT NULL DEFAULT true,jobname text);
INSERT INTO cron.job(jobname,schedule,command) VALUES('context-document-text','*/10 * * * *','SELECT 1');
CREATE OR REPLACE FUNCTION public.context_ghl_history_live_jobs()
RETURNS TABLE(job_id uuid, job_number text, ghl_contact_id text, status text, live_basis text, tier integer, activity_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::text,NULL::integer,NULL::timestamptz WHERE false $$;
