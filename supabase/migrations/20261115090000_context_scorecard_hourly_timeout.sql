-- Context scorecard hourly: the run's statement timeout goes from 60 s to 110 s.
--
-- Why. Every hourly run since 10 Nov 2026 04:40 UTC failed with 57014 (124 runs
-- in a row by 15 Nov): the v2 scorecard no longer fits in 60 s. Measured read
-- only on production on 15 Nov 2026 with 633 monitored jobs:
-- context_ledger_evidence_rows over the monitored jobs (row 6) 44.8 s,
-- context_job_record_timeline (rows 11 to 13) 9.4 s, every other read under
-- 2 s each. The last run that finished (10 Nov 02:40 UTC) took 58.6 s. While it
-- fails nothing is measured: no red row, no alarm and no hourly report exists.
--
-- What. context_scorecard_run_policy(): statement_timeout '110s' and the job's
-- command built from it; the pg_cron job is altered to that command. 110 s is
-- the most the hourly contract allows (under the server's 120 s). slow_after_ms
-- stays 30 s, so a run this slow passes and reads amber on the hourly lane,
-- which is true. Nothing else changes: no table, no other function, no grant.
--
-- Not fixed here: the row 6 evidence read is still slow, and the staff door's
-- 50 s limit on context_scorecard() still cuts it. Making that read cheap is
-- its own change.
--
-- Rollback: supabase/rollbacks/20261115090000_context_scorecard_hourly_timeout_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard: the policy is the hourly migration's, at 60 s (first apply) or
-- already at 110 s (a re-apply); the job, where pg_cron is present, carries
-- one of those two commands on the policy's schedule.
DO $guard$
DECLARE problems text[] := '{}'; pol jsonb; n integer;
BEGIN
 IF to_regprocedure('public.context_scorecard_run_policy()') IS NULL THEN
  RAISE EXCEPTION 'context_scorecard_hourly_timeout_preimage_mismatch: public.context_scorecard_run_policy() is missing';
 END IF;
 IF coalesce(obj_description('public.context_scorecard_run_policy()'::regprocedure, 'pg_proc'), '')
    NOT LIKE 'Context scorecard hourly (20261007040000)%' THEN
  problems := problems || 'public.context_scorecard_run_policy() is not the hourly migration''s'::text;
 END IF;
 pol := public.context_scorecard_run_policy();
 IF pol->>'version' IS DISTINCT FROM 'context-scorecard-hourly-v1' OR NOT (pol->>'statement_timeout' IN ('60s', '110s'))
    OR pol->>'lock_timeout' IS DISTINCT FROM '10s' OR pol->>'schedule' IS DISTINCT FROM '40 * * * *'
    OR pol->>'command' IS DISTINCT FROM format('SET statement_timeout = %L; SET lock_timeout = %L; SELECT public.context_scorecard_record_run(%L)',
         pol->>'statement_timeout', pol->>'lock_timeout', 'cron') THEN
  problems := problems || format('the policy is not the hourly migration''s at 60 s or this one''s at 110 s: %s', pol);
 END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT count(*) FROM cron.job WHERE jobname = $1 AND (schedule IS DISTINCT FROM $2 OR NOT (command = ANY ($3)))'
   INTO n USING 'context-scorecard-hourly', '40 * * * *', ARRAY[
    'SET statement_timeout = ''60s''; SET lock_timeout = ''10s''; SELECT public.context_scorecard_record_run(''cron'')',
    'SET statement_timeout = ''110s''; SET lock_timeout = ''10s''; SELECT public.context_scorecard_record_run(''cron'')'];
  IF n > 0 THEN problems := problems || 'cron job context-scorecard-hourly exists with another schedule or command'::text; END IF;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_scorecard_hourly_timeout_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The policy, word for word the hourly migration's but for the timeout,
-- the command built from it and the note saying why.
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
  -- 110 s since 20261115090000: on 15 Nov 2026 the v2 scorecard took over 60 s
  -- (its row 6 evidence read alone 45 s, its timeline read 9 s on 633 monitored
  -- jobs) and every hourly run since 10 Nov 04:40 UTC was cut at 60 s (57014).
  'statement_timeout', '110s',
  'lock_timeout', '10s',
  'command', 'SET statement_timeout = ''110s''; SET lock_timeout = ''10s''; SELECT public.context_scorecard_record_run(''cron'')',
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
 'Context scorecard hourly (20261007040000): every number of the hourly scorecard run in one place: the pg_cron job (context-scorecard-hourly, 40 * * * * UTC, its command), the run''s statement and lock timeouts (110 s, 10 s), late (75 min), the missed-hour window (24 h) and grades, slow (30 s), keep (180 days), and the report (surface context_scorecard_run_status; readers whose receipts count: rayleigh; a receipt counts for 75 min). Changed only by migration. Hourly timeout (20261115090000): 110 s, was 60 s.';


-- 2. The job. Skipped where pg_cron is absent (the contract runner) or the job
-- is not scheduled; a job already on the new command is left alone.
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
