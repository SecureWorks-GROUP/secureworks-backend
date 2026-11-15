-- Contract for 20261115123000_xero_bank_lines_daily_schedule.
\set ON_ERROR_STOP on

-- 1. The trigger posts the whole read of bank transaction lines, and still posts the five actions it
--    posted before, each to xero-sync with the service key (on a pg_net stand-in). Anything else is refused.
BEGIN;
CREATE SCHEMA net;
CREATE TABLE net.calls (url text, headers jsonb, body jsonb, timeout_milliseconds integer);
CREATE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO net.calls VALUES (url, headers, body, timeout_milliseconds);
  SELECT 1::bigint
$$;
SELECT public.trigger_xero_sync_action('sync_bank_transactions');
DO $$
DECLARE c record; a text; refused boolean := false;
BEGIN
  IF (SELECT count(*) FROM net.calls) <> 1 THEN
    RAISE EXCEPTION 'contract: sync_bank_transactions posted % calls, expected 1', (SELECT count(*) FROM net.calls);
  END IF;
  SELECT * INTO c FROM net.calls;
  IF c.url <> 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_bank_transactions' THEN
    RAISE EXCEPTION 'contract: sync_bank_transactions posted to %', c.url;
  END IF;
  IF c.headers->>'Authorization' IS DISTINCT FROM 'Bearer ' || public.sw_service_key()
     OR c.headers->>'x-sw-actor' IS DISTINCT FROM 'xero-sync-tail-cron'
     OR c.body <> '{}'::jsonb OR c.timeout_milliseconds <> 120000 THEN
    RAISE EXCEPTION 'contract: the post is not the scheduled shape (actor %, body %, timeout %)',
      c.headers->>'x-sw-actor', c.body, c.timeout_milliseconds;
  END IF;
  DELETE FROM net.calls;
  FOREACH a IN ARRAY ARRAY['sync_supplier_credit_notes', 'check_invoice_mirror', 'ingest_materials_recent',
                           'ingest_materials_all', 'bill_prematch'] LOOP
    PERFORM public.trigger_xero_sync_action(a);
  END LOOP;
  IF (SELECT count(*) FROM net.calls) <> 5
     OR (SELECT count(DISTINCT url) FROM net.calls) <> 5 THEN
    RAISE EXCEPTION 'contract: the five earlier actions no longer each post once';
  END IF;
  DELETE FROM net.calls;
  FOREACH a IN ARRAY ARRAY['sync_invoices', 'sync_bank_balances', 'push_bill', '', 'SYNC_BANK_TRANSACTIONS'] LOOP
    refused := false;
    BEGIN
      PERFORM public.trigger_xero_sync_action(a);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'xero_sync_action_not_scheduled:%' THEN RAISE; END IF;
      refused := true;
    END;
    IF NOT refused THEN RAISE EXCEPTION 'contract: action "%" was not refused', a; END IF;
  END LOOP;
  IF (SELECT count(*) FROM net.calls) <> 0 THEN
    RAISE EXCEPTION 'contract: a refused action still posted';
  END IF;
END $$;
ROLLBACK;

-- 2. Only the service role and the owner may call it; its comment names this migration and the new action.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.trigger_xero_sync_action(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trigger_xero_sync_action(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: the xero sync trigger is executable by anon or authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.trigger_xero_sync_action(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: the service role cannot call the xero sync trigger';
  END IF;
  IF NOT (SELECT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']
            FROM pg_proc WHERE oid = 'public.trigger_xero_sync_action(text)'::regprocedure) THEN
    RAISE EXCEPTION 'contract: the trigger is no longer security definer with a pinned search path';
  END IF;
  IF obj_description('public.trigger_xero_sync_action(text)'::regprocedure, 'pg_proc')
       NOT LIKE '20261115123000:%sync_bank_transactions%' THEN
    RAISE EXCEPTION 'contract: the trigger comment does not name 20261115123000 and the new action';
  END IF;
END $$;

-- 3. The schedule, on a pg_cron stand-in: applied twice it leaves exactly one job, daily at 20:01 UTC,
--    stopped by the capture lane, and the jobs already there are untouched. The rollback takes it away
--    and puts the 20261103170000 body back; the migration then applies again.
BEGIN;
\ir cron_stand_in.sql
CREATE TEMP TABLE before_jobs ON COMMIT DROP AS SELECT jobid, jobname, schedule, command, active FROM cron.job;
\ir ../../../migrations/20261115123000_xero_bank_lines_daily_schedule.sql
\ir ../../../migrations/20261115123000_xero_bank_lines_daily_schedule.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'xero-bank-lines-daily') <> 1 THEN
    RAISE EXCEPTION 'contract: expected one xero-bank-lines-daily job, found %',
      (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
  IF (SELECT schedule || ' | ' || command FROM cron.job WHERE jobname = 'xero-bank-lines-daily')
       IS DISTINCT FROM '1 20 * * * | SELECT public.trigger_xero_sync_action(''sync_bank_transactions'') WHERE public.automation_lane_enabled(''capture'')' THEN
    RAISE EXCEPTION 'contract: the schedule or command is wrong: %',
      (SELECT schedule || ' | ' || command FROM cron.job WHERE jobname = 'xero-bank-lines-daily');
  END IF;
  IF NOT (SELECT active FROM cron.job WHERE jobname = 'xero-bank-lines-daily') THEN
    RAISE EXCEPTION 'contract: the new job is not active';
  END IF;
  IF EXISTS (SELECT 1 FROM before_jobs b
              WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE (j.jobid, j.jobname, j.schedule, j.command, j.active)
                                                             = (b.jobid, b.jobname, b.schedule, b.command, b.active)))
     OR (SELECT count(*) FROM cron.job) <> (SELECT count(*) FROM before_jobs) + 1 THEN
    RAISE EXCEPTION 'contract: a job that was already scheduled changed: %',
      (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
END $$;
\ir ../../../rollbacks/20261115123000_xero_bank_lines_daily_schedule_down.sql
\ir ../../../rollbacks/20261115123000_xero_bank_lines_daily_schedule_down.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-bank-lines-daily')
     OR (SELECT count(*) FROM cron.job) <> (SELECT count(*) FROM before_jobs) THEN
    RAISE EXCEPTION 'contract: the rollback did not remove only the new job: %',
      (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.trigger_xero_sync_action(text)'::regprocedure)
       <> 'eeb40769f7c49507f7180e5a453fadcd' THEN
    RAISE EXCEPTION 'contract: the rollback did not restore the 20261103170000 body';
  END IF;
END $$;
\ir ../../../migrations/20261115123000_xero_bank_lines_daily_schedule.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'xero-bank-lines-daily') <> 1 THEN
    RAISE EXCEPTION 'contract: the migration did not schedule again after a rollback';
  END IF;
END $$;
ROLLBACK;
