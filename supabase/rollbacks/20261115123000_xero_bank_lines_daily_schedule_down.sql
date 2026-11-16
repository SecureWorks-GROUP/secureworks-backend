-- Rollback of 20261115123000: remove the daily bank lines schedule and put the trigger back to its
-- 20261103170000 definition (five actions). Lines already copied stay; with no whole read they
-- are kept up only by the 15-minute sync's read of what Xero changed.
SET LOCAL lock_timeout = '5s';
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-bank-lines-daily') THEN
    PERFORM cron.unschedule('xero-bank-lines-daily');
  END IF;
END $cron$;

CREATE OR REPLACE FUNCTION public.trigger_xero_sync_action(p_action text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_action NOT IN ('sync_supplier_credit_notes', 'check_invoice_mirror',
                      'ingest_materials_recent', 'ingest_materials_all', 'bill_prematch') THEN
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
  '20261103170000: posts one of the scheduled xero-sync actions run outside sync_invoices (sync_supplier_credit_notes, check_invoice_mirror, ingest_materials_recent, ingest_materials_all, bill_prematch) with the service key and a 120 s timeout, for their pg_cron jobs. Each used to run only inside sync_invoices, which the edge runtime stopped before or while reaching them.';
REVOKE ALL ON FUNCTION public.trigger_xero_sync_action(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_xero_sync_action(text) TO service_role, postgres;
