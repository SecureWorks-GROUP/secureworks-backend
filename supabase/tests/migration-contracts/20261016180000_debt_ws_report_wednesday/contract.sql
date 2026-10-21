-- Contract for 20261016180000_debt_ws_report_wednesday.sql. Every fixture write is inside
-- a transaction that rolls back.

-- 1. The 11:55 refresh trigger: security definer with a fixed search_path, and not open to
--    the browser roles.
DO $$
DECLARE
  f record;
BEGIN
  SELECT p.prosecdef, p.proconfig INTO f
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.trigger_debt_ws_report_refresh()');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract: trigger_debt_ws_report_refresh is missing';
  END IF;
  IF NOT f.prosecdef OR NOT ('search_path=public, pg_temp' = ANY (f.proconfig)) THEN
    RAISE EXCEPTION 'contract: the refresh trigger must be security definer with a fixed search_path (%)', f.proconfig;
  END IF;
  IF has_function_privilege('anon', 'public.trigger_debt_ws_report_refresh()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trigger_debt_ws_report_refresh()', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: the debt report refresh is executable by anon or authenticated';
  END IF;
END $$;

-- 2. The words follow the new day.
DO $$
BEGIN
  IF col_description('public.debt_ws_settings'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.debt_ws_settings'::regclass
          AND attname = 'report_auto_send')::integer) NOT LIKE '%Wednesday 12:00 Perth%'
     OR obj_description('public.trigger_debt_ws_report_auto()'::regprocedure, 'pg_proc')
          NOT LIKE '%Wed 12:00 Perth%' THEN
    RAISE EXCEPTION 'contract: the report comments still name the old day';
  END IF;
END $$;

-- 3. The refresh is a no-op while report_auto_send is off (the default): no net call, so it
--    returns cleanly where pg_net is absent. Switched on, it posts one invoice sync to
--    xero-sync with the service key (on a pg_net stand-in).
SELECT public.trigger_debt_ws_report_refresh();
BEGIN;
CREATE SCHEMA net;
CREATE TABLE net.calls (url text, headers jsonb, body jsonb);
CREATE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO net.calls VALUES (url, headers, body);
  SELECT 1::bigint
$$;
SELECT public.trigger_debt_ws_report_refresh();
UPDATE public.debt_ws_settings SET report_auto_send = true WHERE id = 1;
SELECT public.trigger_debt_ws_report_refresh();
DO $$
DECLARE
  c record;
BEGIN
  IF (SELECT count(*) FROM net.calls) <> 1 THEN
    RAISE EXCEPTION 'contract: the refresh made % calls, expected 1 (only while auto-send is on)',
      (SELECT count(*) FROM net.calls);
  END IF;
  SELECT * INTO c FROM net.calls;
  IF c.url <> 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_invoices'
     OR c.headers ->> 'Authorization' IS DISTINCT FROM 'Bearer ' || public.sw_service_key() THEN
    RAISE EXCEPTION 'contract: the refresh posted %', row_to_json(c);
  END IF;
END $$;
ROLLBACK;

-- 4. The schedules, on a pg_cron stand-in holding the Monday job: the auto-send moves in
--    place to Wednesday 12:00 Perth, the 11:55 refresh is added, re-applying changes
--    nothing, and the rollback puts Monday back and removes the refresh.
BEGIN;
\ir cron_stand_in.sql
CREATE TEMP TABLE contract_monday_job AS
  SELECT jobid FROM cron.job WHERE jobname = 'debt-ws-report-auto';
\ir ../../../migrations/20261016180000_debt_ws_report_wednesday.sql
\ir ../../../migrations/20261016180000_debt_ws_report_wednesday.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'debt-ws-report-auto') <> 1
     OR (SELECT count(*) FROM cron.job WHERE jobname = 'debt-ws-report-refresh') <> 1 THEN
    RAISE EXCEPTION 'contract: re-apply scheduled twice %', (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
  IF (SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'debt-ws-report-auto')
       <> '0 4 * * 3 SELECT public.trigger_debt_ws_report_auto()' THEN
    RAISE EXCEPTION 'contract: the auto-send is not on Wednesday 12:00 Perth %',
      (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
  IF (SELECT jobid FROM cron.job WHERE jobname = 'debt-ws-report-auto')
       IS DISTINCT FROM (SELECT jobid FROM contract_monday_job) THEN
    RAISE EXCEPTION 'contract: the auto-send job was replaced, not moved in place';
  END IF;
  IF (SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'debt-ws-report-refresh')
       <> '55 3 * * 3 SELECT public.trigger_debt_ws_report_refresh()' THEN
    RAISE EXCEPTION 'contract: the refresh is not on Wednesday 11:55 Perth %',
      (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
END $$;
\ir ../../../rollbacks/20261016180000_debt_ws_report_wednesday_down.sql
DO $$
BEGIN
  IF (SELECT schedule FROM cron.job WHERE jobname = 'debt-ws-report-auto') IS DISTINCT FROM '0 0 * * 1'
     OR EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'debt-ws-report-refresh')
     OR to_regprocedure('public.trigger_debt_ws_report_refresh()') IS NOT NULL THEN
    RAISE EXCEPTION 'contract: the rollback did not restore Monday %', (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
END $$;
ROLLBACK;

-- 5. A missing auto-send job is scheduled fresh on Wednesday.
BEGIN;
\ir cron_stand_in.sql
DELETE FROM cron.job;
\ir ../../../migrations/20261016180000_debt_ws_report_wednesday.sql
DO $$
BEGIN
  IF (SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'debt-ws-report-auto')
       IS DISTINCT FROM '0 4 * * 3 SELECT public.trigger_debt_ws_report_auto()' THEN
    RAISE EXCEPTION 'contract: a missing auto-send job was not scheduled on Wednesday';
  END IF;
END $$;
ROLLBACK;
