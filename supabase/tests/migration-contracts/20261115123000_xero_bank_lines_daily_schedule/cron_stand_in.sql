-- A pg_cron stand-in, created inside a rolled-back transaction: cron.job, cron.schedule and
-- cron.unschedule(name), holding the two production jobs this migration must leave alone.
CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  schedule text NOT NULL,
  command text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  jobname text
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  RETURNING jobid
$$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE sql AS $$
  WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1)
  SELECT count(*) > 0 FROM d
$$;
INSERT INTO cron.job (jobname, schedule, command) VALUES
  ('xero-bank-sync', '45 22 * * *', 'SELECT net.http_post(url:=''https://example.invalid/functions/v1/xero-sync?action=sync_bank_balances'')'),
  ('xero-materials-ingest-all', '40 18 * * *',
   'SELECT public.trigger_xero_sync_action(''ingest_materials_all'') WHERE public.automation_lane_enabled(''capture'')');
