-- Debt Workshop: the debt report goes on Wednesday at 12:00 Perth, on freshly synced debt.
--
-- Shaun (Operations Manager), 16 Oct 2026: "debt report doesn't go Monday, it goes Wednesday
-- at 12pm after consolidating the debt for that day and gets updated."
--
-- This migration:
-- 1. Moves the cron job debt-ws-report-auto from Monday 08:00 Perth ('0 0 * * 1' UTC) to
--    Wednesday 12:00 Perth ('0 4 * * 3' UTC). Its command and its trigger,
--    public.trigger_debt_ws_report_auto(), are unchanged (20261015170000_debt_ws_report.sql).
-- 2. Adds public.trigger_debt_ws_report_refresh() and the cron job debt-ws-report-refresh,
--    Wednesday 11:55 Perth ('55 3 * * 3' UTC). It asks xero-sync for one extra invoice sync
--    (action sync_invoices, the same call the xero-invoice-sync cron makes every 15 minutes
--    at 4, 19, 34 and 49 past the hour), so our Xero copy of the debt is about five minutes
--    old when the report is built at 12:00. 11:55 sits clear of the 11:49 and 12:04 runs (a
--    run takes under a minute), so two syncs never overlap. Like the auto-send trigger it
--    is a no-op unless report_auto_send is on.
--
-- ops-api checks the copy again at 12:00: a report is refused (recorded as 'refused', and
-- nothing is sent) when the last complete invoice sync is more than 20 minutes old, so a
-- missed refresh still has the 11:49 run to fall back on, and a missed pair sends nothing.
--
-- The week is unchanged: at most one auto report per Monday-to-Sunday Perth week, keyed on
-- that week's Monday (debt_ws_reports.week_start). report_auto_send stays as it is (off by
-- default); nothing is sent when this migration applies. Skipped where pg_cron is absent.
-- Re-applying is a no-op. Rollback: supabase/rollbacks/20261016180000_debt_ws_report_wednesday_down.sql.

-- 2. The 11:55 refresh. Posts to xero-sync with the service key from Vault, exactly as the
--    live xero-invoice-sync cron command does.
CREATE OR REPLACE FUNCTION public.trigger_debt_ws_report_refresh()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT coalesce(
    (SELECT report_auto_send FROM public.debt_ws_settings WHERE id = 1), false
  ) THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_invoices',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
END $$;
COMMENT ON FUNCTION public.trigger_debt_ws_report_refresh() IS
  'pg_cron debt-ws-report-refresh (Wed 11:55 Perth): asks xero-sync for one extra invoice sync so the Wednesday 12:00 debt report is built on a copy about five minutes old. A no-op unless debt_ws_settings.report_auto_send is on.';
REVOKE ALL ON FUNCTION public.trigger_debt_ws_report_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_debt_ws_report_refresh() TO service_role, postgres;

-- The words on the switch and the trigger follow the new day.
COMMENT ON COLUMN public.debt_ws_settings.report_auto_send IS
  'Debt report: the Wednesday 12:00 Perth auto-send (and its 11:55 Xero refresh). Default off. Also needs sending_enabled.';
COMMENT ON FUNCTION public.trigger_debt_ws_report_auto() IS
  'pg_cron debt-ws-report-auto (Wed 12:00 Perth): posts ops-api debt_ws_report_auto with the service key while debt_ws_settings.report_auto_send is on. Otherwise a no-op.';

-- 1 and 2. The schedules.
DO $cron$
DECLARE
  v_jobid bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'debt report: pg_cron absent, the Wednesday auto-send is not scheduled';
    RETURN;
  END IF;

  -- The auto-send: move the existing job in place (alter_job keeps its id and history);
  -- schedule it fresh only if it is missing.
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'debt-ws-report-auto') > 1 THEN
    RAISE EXCEPTION 'debt report: more than one debt-ws-report-auto cron job; fix by hand first';
  END IF;
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'debt-ws-report-auto';
  IF v_jobid IS NULL THEN
    PERFORM cron.schedule('debt-ws-report-auto', '0 4 * * 3',
      $cmd$SELECT public.trigger_debt_ws_report_auto()$cmd$);
  ELSE
    PERFORM cron.alter_job(v_jobid, schedule := '0 4 * * 3');
  END IF;

  -- The 11:55 refresh.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'debt-ws-report-refresh') THEN
    PERFORM cron.schedule('debt-ws-report-refresh', '55 3 * * 3',
      $cmd$SELECT public.trigger_debt_ws_report_refresh()$cmd$);
  END IF;
END $cron$;
