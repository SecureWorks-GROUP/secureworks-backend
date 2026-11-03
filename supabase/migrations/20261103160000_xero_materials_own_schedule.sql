-- B1 (finish line, 3 Nov 2026): the supplier bill ingest and the bill pre-match get their own schedules.
--
-- Since 29 Oct 02:19Z every 15-minute sync_invoices run has been stopped for CPU time inside its
-- bills step: #1184 widened that step to every bill (about 1,600 open rows in Bills to place). No
-- pre-match proposal was written after 31 Oct 22:49Z, and the steps after it (bank feed copy, stale
-- invoice re-check, settlement capture) have not run since 29 Oct. The xero-sync code in this change
-- takes the bills step out of sync_invoices; this migration schedules it on its own:
--   xero-materials-ingest      11-59/15 * * * *  action=ingest_materials_recent  (last 90 days)
--   xero-bill-prematch         13-59/15 * * * *  action=bill_prematch            (300 open bills a run, new first)
--   xero-materials-ingest-all  40 18 * * *       action=ingest_materials_all     (every bill, 02:40 Perth)
-- Same trigger and lane as 20261102080000 (xero-supplier-credit-sync, xero-invoice-mirror-check):
-- the helper gains three allowed actions; each schedule stops with the capture lane.
-- Rollback: supabase/rollbacks/20261103160000_xero_materials_own_schedule_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE v text;
BEGIN
  SELECT md5(pg_get_functiondef('public.trigger_xero_sync_action(text)'::regprocedure)) INTO v;
  -- 666dafff...: the 20261102080000 definition (two actions). Already replaced: run again safely.
  IF v NOT IN ('666dafff29fd30532d3f02b83ee8ffa9') AND NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = 'public.trigger_xero_sync_action(text)'::regprocedure
          AND prosrc LIKE '%bill_prematch%') THEN
    RAISE EXCEPTION 'trigger_xero_sync_action changed since 20261102080000 (md5 %); refusing', v;
  END IF;
END $guard$;

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
  '20261103160000: posts one of the scheduled xero-sync actions run outside sync_invoices (sync_supplier_credit_notes, check_invoice_mirror, ingest_materials_recent, ingest_materials_all, bill_prematch) with the service key and a 120 s timeout, for their pg_cron jobs. Each used to run only inside sync_invoices, which the edge runtime stopped before or while reaching them.';
REVOKE ALL ON FUNCTION public.trigger_xero_sync_action(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_xero_sync_action(text) TO service_role, postgres;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'xero materials schedules: pg_cron absent, not scheduled';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-materials-ingest') THEN
    PERFORM cron.schedule('xero-materials-ingest', '11-59/15 * * * *',
      $cmd$SELECT public.trigger_xero_sync_action('ingest_materials_recent') WHERE public.automation_lane_enabled('capture')$cmd$);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-bill-prematch') THEN
    PERFORM cron.schedule('xero-bill-prematch', '13-59/15 * * * *',
      $cmd$SELECT public.trigger_xero_sync_action('bill_prematch') WHERE public.automation_lane_enabled('capture')$cmd$);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-materials-ingest-all') THEN
    PERFORM cron.schedule('xero-materials-ingest-all', '40 18 * * *',
      $cmd$SELECT public.trigger_xero_sync_action('ingest_materials_all') WHERE public.automation_lane_enabled('capture')$cmd$);
  END IF;
END $cron$;
