-- A live change nobody read: the ghl_capture block already replaced by some
-- other body, and a ghl-message-reconcile cron job with another command. The
-- guard must refuse and name both.
CREATE OR REPLACE FUNCTION public.context_ghl_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT '{"alarms":[]}'::jsonb $$;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY,schedule text NOT NULL,command text NOT NULL,active boolean NOT NULL DEFAULT true,jobname text);
INSERT INTO cron.job(jobname,schedule,command) VALUES('ghl-message-reconcile','*/5 * * * *','SELECT 1');
