-- Captain-gated rollback for 20260723000001_makesafe_board_truth_shadow.sql.
-- Reverses only the additive M1 shadow surfaces. Declared substatus and all
-- operational evidence are untouched.

DO $$
BEGIN
  PERFORM cron.unschedule('makesafe-status-shadow-refresh')
    FROM cron.job WHERE jobname = 'makesafe-status-shadow-refresh';
  PERFORM cron.unschedule('makesafe-status-canary')
    FROM cron.job WHERE jobname = 'makesafe-status-canary';
END $$;

DROP FUNCTION IF EXISTS public.trigger_makesafe_status_shadow_refresh();
DROP FUNCTION IF EXISTS public.trigger_makesafe_status_canary();
DROP VIEW IF EXISTS public.makesafe_status_disagreements;
DROP FUNCTION IF EXISTS public.refresh_makesafe_status_shadow(jsonb);
DROP TABLE IF EXISTS public.makesafe_status_holds;
ALTER TABLE public.makesafe_job_details
  DROP CONSTRAINT IF EXISTS makesafe_job_details_computed_status_check,
  DROP COLUMN IF EXISTS computed_status,
  DROP COLUMN IF EXISTS computed_status_reasons,
  DROP COLUMN IF EXISTS computed_status_missing,
  DROP COLUMN IF EXISTS computed_status_at;
