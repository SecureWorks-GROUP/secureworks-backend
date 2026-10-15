-- Rollback for 20261015170000_debt_ws_report.sql.
--
-- Removes the Monday auto-send cron job and its trigger, the payments read, the
-- debt_ws_reports table and the three report settings on debt_ws_settings.
--
-- Fail-closed: it refuses while any report send is recorded (a debt_ws_reports row), so a
-- rollback never silently discards the copy of what was emailed. Export or delete those
-- rows first, on purpose. Re-running it is a no-op. The rest of the Debt Workshop
-- (20261008170000_debt_workshop.sql) is untouched.

DO $$
DECLARE
  v_count bigint := 0;
BEGIN
  IF to_regclass('public.debt_ws_reports') IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM public.debt_ws_reports;
  END IF;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'rollback refused: % debt report send record(s) exist in debt_ws_reports', v_count;
  END IF;
END $$;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'debt-ws-report-auto';
END $cron$;

DROP FUNCTION IF EXISTS public.trigger_debt_ws_report_auto();
DROP FUNCTION IF EXISTS public.debt_ws_payments_between(uuid, date, date);
DROP TABLE IF EXISTS public.debt_ws_reports;

ALTER TABLE IF EXISTS public.debt_ws_settings
  DROP CONSTRAINT IF EXISTS debt_ws_settings_report_addresses_internal;
ALTER TABLE IF EXISTS public.debt_ws_settings
  DROP COLUMN IF EXISTS report_recipients,
  DROP COLUMN IF EXISTS report_cc,
  DROP COLUMN IF EXISTS report_auto_send;
