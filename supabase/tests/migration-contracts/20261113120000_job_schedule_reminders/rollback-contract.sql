-- The runner has just run the down migration against the forward stack.
-- 1. The switch and the cron caller are gone; the text record and the run log are kept;
-- the other close-out switches remain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'job_closeout_settings'
                AND column_name = 'schedule_reminder_mode') THEN
    RAISE EXCEPTION 'rollback contract: schedule_reminder_mode is still there';
  END IF;
  IF to_regprocedure('public.trigger_job_schedule_reminders()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: trigger_job_schedule_reminders is still there';
  END IF;
  IF to_regclass('public.job_schedule_reminders') IS NULL
     OR to_regclass('public.job_schedule_reminder_runs') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the text record or the run log was dropped';
  END IF;
  IF (SELECT deposit_advance_mode FROM public.job_closeout_settings WHERE id = 1) IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the deposit switch is gone';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261113120000_job_schedule_reminders_down.sql

-- 3. The forward migration applies again cleanly after a rollback, switched off.
BEGIN;
\ir ../../../migrations/20261113120000_job_schedule_reminders.sql
DO $$
BEGIN
  IF to_regprocedure('public.trigger_job_schedule_reminders()') IS NULL
     OR (SELECT schedule_reminder_mode FROM public.job_closeout_settings WHERE id = 1) <> 'off' THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
