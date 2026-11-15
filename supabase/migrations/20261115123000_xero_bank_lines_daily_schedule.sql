-- Tie to Xero (15 Nov 2026): the daily whole read of bank transaction lines gets its schedule.
--
-- 20261115110000 added the copy of each bank transaction's lines, and xero-sync's action
-- sync_bank_transactions does the whole read of them (the first run back to 1 July of the financial
-- year, later runs the last 90 days, each checked against Xero's own list, plus the chart of
-- accounts). No pg_cron job calls that action: xero-bank-sync (45 22 * * *) calls
-- sync_bank_balances. The 15-minute sync reads no lines until a first whole read has run, so
-- without this schedule card and bank spend would read "not read yet" for good.
--   xero-bank-lines-daily  1 20 * * *  action=sync_bank_transactions  (04:01 Perth)
-- Same trigger and lane as 20261102080000 and 20261103170000: the helper gains one allowed action,
-- and the schedule stops with the capture lane. The action reads Xero (GET only) and writes our copy.
-- Rollback: supabase/rollbacks/20261115123000_xero_bank_lines_daily_schedule_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE v text;
BEGIN
  IF to_regprocedure('public.trigger_xero_sync_action(text)') IS NULL THEN
    RAISE EXCEPTION 'trigger_xero_sync_action(text) is missing; apply 20261103170000 first';
  END IF;
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public.trigger_xero_sync_action(text)'::regprocedure;
  -- eeb40769...: the body of the 20261103170000 definition (five actions), as read on production on
  -- 15 Nov 2026. Already replaced by this migration: run again safely.
  IF v NOT IN ('eeb40769f7c49507f7180e5a453fadcd') AND NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = 'public.trigger_xero_sync_action(text)'::regprocedure
          AND prosrc LIKE '%sync_bank_transactions%') THEN
    RAISE EXCEPTION 'trigger_xero_sync_action changed since 20261103170000 (body md5 %); refusing', v;
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.trigger_xero_sync_action(p_action text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_action NOT IN ('sync_supplier_credit_notes', 'check_invoice_mirror',
                      'ingest_materials_recent', 'ingest_materials_all', 'bill_prematch',
                      'sync_bank_transactions') THEN
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
  '20261115123000: posts one of the scheduled xero-sync actions run outside sync_invoices (sync_supplier_credit_notes, check_invoice_mirror, ingest_materials_recent, ingest_materials_all, bill_prematch, sync_bank_transactions) with the service key and a 120 s timeout, for their pg_cron jobs. sync_bank_transactions is the daily whole read of bank transaction lines and the chart of accounts (xero-bank-lines-daily); it reads Xero only.';
REVOKE ALL ON FUNCTION public.trigger_xero_sync_action(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_xero_sync_action(text) TO service_role, postgres;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'xero bank lines schedule: pg_cron absent, not scheduled';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-bank-lines-daily') THEN
    PERFORM cron.schedule('xero-bank-lines-daily', '1 20 * * *',
      $cmd$SELECT public.trigger_xero_sync_action('sync_bank_transactions') WHERE public.automation_lane_enabled('capture')$cmd$);
  END IF;
END $cron$;
