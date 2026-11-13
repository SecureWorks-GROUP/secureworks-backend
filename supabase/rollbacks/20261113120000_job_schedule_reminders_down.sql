-- Rollback of 20261113120000_job_schedule_reminders.sql: unschedules the cron, drops its
-- caller and the switch. The text record and the run log are kept (they are the only
-- record of who was texted); a re-apply finds them and leaves them as they are.
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'job-schedule-reminders') THEN
    PERFORM cron.unschedule('job-schedule-reminders');
  END IF;
END $cron$;

DROP FUNCTION IF EXISTS public.trigger_job_schedule_reminders();

ALTER TABLE public.job_closeout_settings
  DROP COLUMN IF EXISTS schedule_reminder_mode;
