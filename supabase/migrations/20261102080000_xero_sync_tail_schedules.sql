-- Xero sync: give the steps at the end of sync_invoices their own schedule,
-- 2 Nov 2026 (Road to done P1).
--
-- Found 2 Nov 2026: every scheduled xero-sync?action=sync_invoices request in
-- the last day ended in status 546 (the edge runtime's resource limit), so the
-- steps after the stop never ran from it: the supplier credit note copy
-- (TP-07 slice 1), settlement evidence, the hourly Xero mirror check and the
-- sync's own log row (webhook_log shows only the purchase-order sync). Run by
-- hand on 2 Nov 05:05:48Z, sync_supplier_credit_notes completed in seconds
-- (87 notes, 85 allocations). This adds two schedules that call the existing
-- standalone actions directly, each with a 120 second client timeout:
--   xero-supplier-credit-sync  20,50 * * * *  action=sync_supplier_credit_notes
--   xero-invoice-mirror-check  27 * * * *     action=check_invoice_mirror
-- Both read Xero only and write only SecureSuite's copy; neither writes to Xero.
-- The credit note action does nothing while xero_supplier_credit_notes_v1 is
-- off. Both stop with the capture lane. sync_invoices itself is unchanged; its
-- 546 is a separate fix (settlement evidence has no standalone action yet).
-- Rollback: supabase/rollbacks/20261102080000_xero_sync_tail_schedules_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.trigger_xero_sync_action(p_action text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_action NOT IN ('sync_supplier_credit_notes', 'check_invoice_mirror') THEN
    RAISE EXCEPTION 'xero_sync_action_not_scheduled: %', p_action;
  END IF;
  RETURN net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=' || p_action,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || public.sw_service_key(),
                                  'x-sw-actor', 'xero-sync-tail-cron'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
END $fn$;
COMMENT ON FUNCTION public.trigger_xero_sync_action(text) IS
  '20261102080000: posts one of the two read-only xero-sync tail actions (sync_supplier_credit_notes, check_invoice_mirror) with the service key and a 120 s timeout, for pg_cron jobs xero-supplier-credit-sync and xero-invoice-mirror-check. They used to run only at the end of sync_invoices, which the edge runtime stops (546) before reaching them.';
REVOKE ALL ON FUNCTION public.trigger_xero_sync_action(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_xero_sync_action(text) TO service_role, postgres;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'xero sync tail: pg_cron absent, not scheduled';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-supplier-credit-sync') THEN
    PERFORM cron.schedule('xero-supplier-credit-sync', '20,50 * * * *',
      $cmd$SELECT public.trigger_xero_sync_action('sync_supplier_credit_notes') WHERE public.automation_lane_enabled('capture')$cmd$);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-invoice-mirror-check') THEN
    PERFORM cron.schedule('xero-invoice-mirror-check', '27 * * * *',
      $cmd$SELECT public.trigger_xero_sync_action('check_invoice_mirror') WHERE public.automation_lane_enabled('capture')$cmd$);
  END IF;
END $cron$;
