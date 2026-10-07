-- Rollback of 20261007040000_context_scorecard_hourly (the hourly scorecard run).
--
-- Unschedules the pg_cron job context-scorecard-hourly, closes the open red-row
-- report it raised (resolved_at now; the ai_alerts rows are kept as history),
-- then drops the status read, the recorder, the policy and the run log (its
-- history goes with it). Nothing else was created or changed by the forward
-- migration: context_scorecard and ai_alerts are untouched.
--
-- Refuses while public.context_scorecard reads context_scorecard_run_status
-- (the scorecard v2's hourly_run lane): dropping the read would break the
-- scorecard at its next call, so roll that scorecard back first. One statement,
-- so a refusal leaves everything in place.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $down$
BEGIN
 IF to_regprocedure('public.context_scorecard(timestamptz)') IS NOT NULL
    AND position('context_scorecard_run_status' IN
                 (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_scorecard(timestamptz)'))) > 0 THEN
  RAISE EXCEPTION 'context_scorecard_hourly_rollback_refused: public.context_scorecard(timestamptz) reads context_scorecard_run_status; roll that scorecard back first';
 END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'context-scorecard-hourly') THEN
   PERFORM cron.unschedule('context-scorecard-hourly');
  END IF;
 END IF;
 IF to_regclass('public.ai_alerts') IS NOT NULL THEN
  UPDATE public.ai_alerts SET resolved_at = now()
  WHERE alert_type = 'context_scorecard_red_rows' AND resolved_at IS NULL AND dismissed_at IS NULL;
 END IF;
 DROP FUNCTION IF EXISTS public.context_scorecard_run_status(timestamptz);
 DROP FUNCTION IF EXISTS public.context_scorecard_record_run(text);
 DROP FUNCTION IF EXISTS public.context_scorecard_run_policy();
 DROP TABLE IF EXISTS public.context_scorecard_runs;
END $down$;
