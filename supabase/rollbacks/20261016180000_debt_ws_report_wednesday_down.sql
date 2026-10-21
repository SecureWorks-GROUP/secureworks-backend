-- Rollback for 20261016180000_debt_ws_report_wednesday.sql.
--
-- Puts the debt report auto-send back on Monday 08:00 Perth ('0 0 * * 1' UTC), removes the
-- Wednesday 11:55 Xero refresh (its cron job and its trigger) and restores the Monday words
-- on the switch and the trigger. Nothing else changes: debt_ws_reports, the settings and
-- report_auto_send keep their values. Re-running it is a no-op. Skipped where pg_cron is
-- absent (the comments and the function are still restored and removed).
--
-- Note: the ops-api that ships with the Wednesday change refuses a report built on a copy
-- of the debt more than 20 minutes old. On a Monday 08:00 run that still holds (the
-- 15-minute invoice sync keeps the copy fresh), so the rollback needs no code change.

DO $cron$
DECLARE
  v_jobid bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'debt-ws-report-refresh';
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'debt-ws-report-auto' LIMIT 1;
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, schedule := '0 0 * * 1');
  END IF;
END $cron$;

DROP FUNCTION IF EXISTS public.trigger_debt_ws_report_refresh();

COMMENT ON COLUMN public.debt_ws_settings.report_auto_send IS
  'Debt report: the Monday 08:00 Perth auto-send. Default off. Also needs sending_enabled.';
COMMENT ON FUNCTION public.trigger_debt_ws_report_auto() IS
  'pg_cron debt-ws-report-auto (Mon 08:00 Perth): posts ops-api debt_ws_report_auto with the service key while debt_ws_settings.report_auto_send is on. Otherwise a no-op.';
