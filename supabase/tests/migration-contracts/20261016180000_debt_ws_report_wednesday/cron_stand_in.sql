-- A pg_cron stand-in, created inside a rolled-back transaction: cron.job, cron.schedule,
-- cron.alter_job and cron.unschedule(name), with the production Monday job as the
-- 20261015170000 migration left it.
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
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL,
  command text DEFAULT NULL, database text DEFAULT NULL, username text DEFAULT NULL,
  active boolean DEFAULT NULL) RETURNS void
LANGUAGE sql AS $$
  UPDATE cron.job
     SET schedule = coalesce(alter_job.schedule, job.schedule),
         command = coalesce(alter_job.command, job.command),
         active = coalesce(alter_job.active, job.active)
   WHERE jobid = job_id
$$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE sql AS $$
  WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1)
  SELECT count(*) > 0 FROM d
$$;
INSERT INTO cron.job (jobname, schedule, command)
VALUES ('debt-ws-report-auto', '0 0 * * 1', 'SELECT public.trigger_debt_ws_report_auto()');
