-- Rollback of 20261102140000_job_auto_start.sql: unschedules the cron and drops its
-- caller. The flag row and the run log are kept (the runs are the only record of what
-- moved); turn the flag off instead of deleting it.
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'job-auto-start') THEN
    PERFORM cron.unschedule('job-auto-start');
  END IF;
END $cron$;

DROP FUNCTION IF EXISTS public.trigger_job_auto_start();

UPDATE public.feature_flags SET enabled = false, updated_at = now()
  WHERE flag_name = 'job_auto_start_v1';
