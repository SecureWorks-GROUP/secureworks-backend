-- Pre-migration surface for 20261115123000_xero_bank_lines_daily_schedule. The two earlier Xero schedule
-- migrations (20261102080000, 20261103170000) are not registered cases, so this setup stands the trigger
-- up exactly as 20261103170000 left it on production (body md5 eeb40769..., read there on 15 Nov 2026).
-- public.sw_service_key() comes from an earlier setup. Earlier cases assert that no cron or net schema
-- exists, so the pg_cron and pg_net stand-ins live inside contract.sql's rolled-back transactions.
DO $$
BEGIN
  IF to_regprocedure('public.sw_service_key()') IS NULL THEN
    RAISE EXCEPTION 'xero bank lines schedule setup: public.sw_service_key() missing from the registered stack';
  END IF;
END $$;

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
REVOKE ALL ON FUNCTION public.trigger_xero_sync_action(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_xero_sync_action(text) TO service_role, postgres;

DO $$
DECLARE v text;
BEGIN
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public.trigger_xero_sync_action(text)'::regprocedure;
  IF v <> 'eeb40769f7c49507f7180e5a453fadcd' THEN
    RAISE EXCEPTION 'xero bank lines schedule setup: the stand-in body is not production''s (md5 %)', v;
  END IF;
END $$;
