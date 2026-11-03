-- Rollback of 20261103160000: remove the three bills schedules and put the trigger back to its
-- 20261102080000 definition (two actions). The xero-sync code must be rolled back with it, or the
-- bills step runs nowhere.
SET LOCAL lock_timeout = '5s';
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('xero-materials-ingest', 'xero-bill-prematch', 'xero-materials-ingest-all');
END $cron$;

CREATE OR REPLACE FUNCTION public.trigger_xero_sync_action(p_action text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$
;
COMMENT ON FUNCTION public.trigger_xero_sync_action(text) IS
  '20261102080000: posts one of the two read-only xero-sync tail actions (sync_supplier_credit_notes, check_invoice_mirror) with the service key and a 120 s timeout, for pg_cron jobs xero-supplier-credit-sync and xero-invoice-mirror-check. They used to run only at the end of sync_invoices, which the edge runtime stops (546) before reaching them.';
