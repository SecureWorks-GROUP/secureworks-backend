-- Rollback of 20261117150000: remove the weekly test chat timer (daily-digest-canary).
--
-- The daily-digest job and public.trigger_daily_digest_action stay. The job's old
-- command carried a pasted key; it is not put back. With the matching function rolled
-- back too, action=build is a server POST, which that function treats as its normal
-- full run, so the daily build keeps working.
SET LOCAL lock_timeout = '5s';
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-digest-canary') THEN
    PERFORM cron.unschedule('daily-digest-canary');
  END IF;
END $cron$;
