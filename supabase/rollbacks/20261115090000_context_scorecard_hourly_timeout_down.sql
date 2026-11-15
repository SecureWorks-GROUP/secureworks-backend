-- Rollback for 20261115090000_context_scorecard_hourly_timeout.sql: the hourly
-- run's policy and its pg_cron job go back to the 60 s statement timeout, word
-- for word the hourly migration's (20261007040000). A re-run is a no-op.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE pol jsonb := public.context_scorecard_run_policy();
BEGIN
 IF pol->>'version' IS DISTINCT FROM 'context-scorecard-hourly-v1' OR coalesce(pol->>'statement_timeout', '') NOT IN ('60s', '110s') THEN
  RAISE EXCEPTION 'context_scorecard_hourly_timeout_down_refused: a later change replaced the policy, roll it back first: %', pol;
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.context_scorecard_run_policy()
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT jsonb_build_object(
  'version', 'context-scorecard-hourly-v1',
  -- The pg_cron job. UTC (cron.timezone is GMT): minute 40 of every hour.
  'cron_job', 'context-scorecard-hourly',
  'schedule', '40 * * * *',
  -- The run's own limits, set by the job's command before the call. The
  -- scorecard took 1.06 to 1.24 s on 7 Oct 2026; the server limit is 120 s.
  'statement_timeout', '60s',
  'lock_timeout', '10s',
  'command', 'SET statement_timeout = ''60s''; SET lock_timeout = ''10s''; SELECT public.context_scorecard_record_run(''cron'')',
  -- Grading the hourly run (row 10, lane hourly_run). Late: the newest run is
  -- older than this many minutes (an hour plus 15 minutes of grace). Missed:
  -- a whole UTC hour in the window, since the first run, with no ok run; one
  -- missed hour is amber, more is red. Slow: an ok run took longer than this,
  -- half the statement timeout (amber).
  'late_after_minutes', 75,
  'window_hours', 24,
  'missed_hours', jsonb_build_object('green', 0, 'amber', 1),
  'slow_after_ms', 30000,
  -- Runs older than this many days are deleted by the recorder (receipts go with them).
  'keep_days', 180,
  -- Where red rows are reported: only through context_scorecard_run_status,
  -- read by these readers (done definition row 10: "Rayleigh runs it hourly
  -- and reports only red rows"), each recording a receipt once it has passed
  -- the report on. The lane is red when no reader's receipt is newer than this
  -- many minutes. Nothing else is written (see the migration header).
  'report', jsonb_build_object('surface', 'context_scorecard_run_status', 'readers', jsonb_build_array('rayleigh'),
   'receipt_fresh_minutes', 75)
 )
$fn$;
COMMENT ON FUNCTION public.context_scorecard_run_policy() IS
 'Context scorecard hourly (20261007040000): every number of the hourly scorecard run in one place: the pg_cron job (context-scorecard-hourly, 40 * * * * UTC, its command), the run''s statement and lock timeouts (60 s, 10 s), late (75 min), the missed-hour window (24 h) and grades, slow (30 s), keep (180 days), and the report (surface context_scorecard_run_status; readers whose receipts count: rayleigh; a receipt counts for 75 min). Changed only by migration.';


-- The job, back to the policy's command. Skipped where pg_cron is absent (the contract runner) or the job
-- is not scheduled; a job already on that command is left alone.
DO $cron$
DECLARE v_pol jsonb := public.context_scorecard_run_policy(); v_id bigint;
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'context-scorecard-hourly: pg_cron absent, job not altered';
  RETURN;
 END IF;
 EXECUTE 'SELECT jobid FROM cron.job WHERE jobname = $1 AND command IS DISTINCT FROM $2' INTO v_id
  USING v_pol->>'cron_job', v_pol->>'command';
 IF v_id IS NOT NULL THEN
  IF to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') IS NOT NULL THEN
   PERFORM cron.alter_job(job_id := v_id, command := v_pol->>'command');
  ELSE
   EXECUTE 'UPDATE cron.job SET command = $1 WHERE jobid = $2' USING v_pol->>'command', v_id;
  END IF;
 END IF;
END $cron$;
