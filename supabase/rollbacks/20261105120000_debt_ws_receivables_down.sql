-- Rollback for 20261105120000_debt_ws_receivables.sql.
--
-- Puts the Wednesday debt report back at 12:00 Perth ('0 4 * * 3' UTC) and its Xero refresh
-- back at 11:55 ('55 3 * * 3' UTC), with the 12:00 words on the switch and the triggers;
-- removes the company terms write path (debt_ws_set_company_terms) and the two terms
-- columns with their checks. report_auto_send and every other setting keep their values.
-- Re-running it is a no-op. Skipped where pg_cron is absent (the rest still applies).
--
-- Note: ops-api reads the terms columns apart from the other settings. With them gone the
-- Debt tab keeps working and puts every company on 10 days (so Ambrose goes back to 10), and
-- changing a company's terms on the tab fails cleanly until the migration is applied again.
-- Any terms the owner set are lost with the columns.

DO $cron$
DECLARE
  v_jobid bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'debt-ws-report-auto' LIMIT 1;
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, schedule := '0 4 * * 3');
  END IF;
  v_jobid := NULL;
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'debt-ws-report-refresh' LIMIT 1;
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, schedule := '55 3 * * 3');
  END IF;
END $cron$;

COMMENT ON COLUMN public.debt_ws_settings.report_auto_send IS
  'Debt report: the Wednesday 12:00 Perth auto-send (and its 11:55 Xero refresh). Default off. Also needs sending_enabled.';
COMMENT ON FUNCTION public.trigger_debt_ws_report_auto() IS
  'pg_cron debt-ws-report-auto (Wed 12:00 Perth): posts ops-api debt_ws_report_auto with the service key while debt_ws_settings.report_auto_send is on. Otherwise a no-op.';
COMMENT ON FUNCTION public.trigger_debt_ws_report_refresh() IS
  'pg_cron debt-ws-report-refresh (Wed 11:55 Perth): asks xero-sync for one extra invoice sync so the Wednesday 12:00 debt report is built on a copy about five minutes old. A no-op unless debt_ws_settings.report_auto_send is on.';

DROP FUNCTION IF EXISTS public.debt_ws_set_company_terms(text, integer, text);

ALTER TABLE public.debt_ws_settings
  DROP CONSTRAINT IF EXISTS debt_ws_settings_company_terms_valid,
  DROP CONSTRAINT IF EXISTS debt_ws_settings_company_terms_default_range,
  DROP COLUMN IF EXISTS company_terms,
  DROP COLUMN IF EXISTS company_terms_default;

DROP FUNCTION IF EXISTS public.debt_ws_company_terms_valid(jsonb);
