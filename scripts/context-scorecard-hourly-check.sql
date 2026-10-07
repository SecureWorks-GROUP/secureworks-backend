-- The hourly scorecard run (migration 20261007040000_context_scorecard_hourly):
-- the check after it lands, and an optional first run.
--
-- Not run by its author. PART 1 is READ ONLY. PART 2 is a WRITE, a dry run: as
-- written it ends in ROLLBACK and changes nothing. Production: run each PART on
-- its own, PART 2 only after the migration is applied and only if the first
-- run should not wait for the next minute 40 (UTC) of the hour.

-- PART 1 (read only). Expect: the ledger row; one job context-scorecard-hourly,
-- active, schedule 40 * * * *, command_matches true; after its first minute 40,
-- a pg_cron run that succeeded and a stored run (status ok, or failed with a
-- SQLSTATE that says why); the lane; and, while rows are red, one open report.
BEGIN READ ONLY;
SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261007040000';
SELECT j.jobid, j.jobname, j.schedule, j.active, j.username,
       j.command = public.context_scorecard_run_policy()->>'command' AS command_matches
FROM cron.job j WHERE j.jobname = 'context-scorecard-hourly';
SELECT d.runid, d.status, d.start_time, d.end_time - d.start_time AS took
FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
WHERE j.jobname = 'context-scorecard-hourly' ORDER BY d.start_time DESC LIMIT 5;
SELECT r.id, r.run_trigger, r.as_of, r.duration_ms, r.status, r.error_code, r.red_rows, r.report->>'action' AS report
FROM public.context_scorecard_runs r ORDER BY r.id DESC LIMIT 5;
SELECT s->'lane' AS lane, s->'report' AS report, s->'window' AS run_window, s->'cron' AS cron_job
FROM (SELECT public.context_scorecard_run_status() AS s) x;
SELECT a.id, a.created_at, a.severity, a.message, a.resolved_at, a.dismissed_at
FROM public.ai_alerts a WHERE a.alert_type = 'context_scorecard_red_rows' ORDER BY a.created_at DESC LIMIT 3;
ROLLBACK;

-- PART 2 (write, dry run). Records the first run now: one context_scorecard_runs
-- row and, when rows are red, one ai_alerts row of alert_type
-- context_scorecard_red_rows. Sends nothing. The guards hold it to the first
-- run only. To keep it, change the final ROLLBACK to COMMIT.
-- Undo after a COMMIT, with the ids it printed:
--   DELETE FROM public.ai_alerts WHERE id = '<report alert_id>' AND alert_type = 'context_scorecard_red_rows';
--   DELETE FROM public.context_scorecard_runs WHERE id = <run_id>;
BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '10s';
DO $before$
BEGIN
 IF to_regprocedure('public.context_scorecard_record_run(text)') IS NULL THEN
  RAISE EXCEPTION 'first run: 20261007040000 is not applied';
 END IF;
 IF (SELECT count(*) FROM public.context_scorecard_runs) <> 0 THEN
  RAISE EXCEPTION 'first run: % runs are already stored; nothing to do', (SELECT count(*) FROM public.context_scorecard_runs);
 END IF;
 IF (SELECT count(*) FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows') <> 0 THEN
  RAISE EXCEPTION 'first run: a red-row report already exists';
 END IF;
END $before$;
SELECT public.context_scorecard_record_run('manual') AS first_run;
DO $after$
BEGIN
 IF (SELECT count(*) FROM public.context_scorecard_runs) <> 1 THEN
  RAISE EXCEPTION 'first run: expected exactly 1 stored run, found %', (SELECT count(*) FROM public.context_scorecard_runs);
 END IF;
 IF (SELECT count(*) FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows') > 1 THEN
  RAISE EXCEPTION 'first run: expected at most 1 report row';
 END IF;
END $after$;
SELECT r.id AS run_id, r.status, r.error_code, r.red_rows, r.report->>'alert_id' AS alert_id
FROM public.context_scorecard_runs r;
ROLLBACK;
