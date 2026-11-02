-- Rollback of 20261102080000: remove the two tail schedules and their trigger.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('xero-supplier-credit-sync', 'xero-invoice-mirror-check');
  END IF;
END $cron$;
DROP FUNCTION IF EXISTS public.trigger_xero_sync_action(text);
