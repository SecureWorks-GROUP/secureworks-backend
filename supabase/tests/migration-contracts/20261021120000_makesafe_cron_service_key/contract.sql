-- Contract for 20261021120000_makesafe_cron_service_key.sql: the make-safe
-- email reconcile (D1, D2, D3), email canary (D4) and status canary crons post
-- `Bearer <sw_service_key()>`, read no vault secret themselves, and still do
-- nothing while makesafe_cron_enabled() is off. Fixture writes roll back.

-- 1. Both bodies read the key through sw_service_key() only, keep the gate, and
--    stay security definer with a fixed search_path, closed to browser roles.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig, p.prosrc, p.prosecdef, p.proconfig
      FROM pg_proc p
     WHERE p.oid IN (to_regprocedure('public.trigger_makesafe_reconcile(text)'),
                     to_regprocedure('public.trigger_makesafe_status_canary()'))
  LOOP
    IF f.prosrc ~* 'vault' OR f.prosrc ~* 'decrypted_secret' THEN
      RAISE EXCEPTION 'contract: % still reads the vault secret itself', f.sig;
    END IF;
    IF position('''Bearer '' || public.sw_service_key()' in f.prosrc) = 0 THEN
      RAISE EXCEPTION 'contract: % does not post Bearer sw_service_key()', f.sig;
    END IF;
    IF position('IF NOT public.makesafe_cron_enabled() THEN' in f.prosrc) = 0 THEN
      RAISE EXCEPTION 'contract: % lost the makesafe_cron_enabled() gate', f.sig;
    END IF;
    IF NOT f.prosecdef OR NOT ('search_path=public, pg_temp' = ANY (f.proconfig)) THEN
      RAISE EXCEPTION 'contract: % must be security definer with a fixed search_path (%)', f.sig, f.proconfig;
    END IF;
    IF has_function_privilege('anon', f.sig::oid, 'EXECUTE')
       OR has_function_privilege('authenticated', f.sig::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract: % is executable by anon or authenticated', f.sig;
    END IF;
    IF NOT has_function_privilege('service_role', f.sig::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract: % is not executable by service_role', f.sig;
    END IF;
  END LOOP;
  IF to_regprocedure('public.trigger_makesafe_reconcile(text)') IS NULL
     OR to_regprocedure('public.trigger_makesafe_status_canary()') IS NULL THEN
    RAISE EXCEPTION 'contract: a make-safe cron trigger is missing';
  END IF;
END $$;

-- 2. Gate off (the fixture): both return without reaching net.http_post, which
--    does not exist here, so a call would raise.
SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile');
SELECT public.trigger_makesafe_status_canary();

-- 3. Gate on, on a pg_net stand-in: each of the five crons posts its ops-api
--    action with Bearer sw_service_key() and an empty body.
BEGIN;
CREATE SCHEMA net;
CREATE TABLE net.calls (n serial, url text, headers jsonb, body jsonb);
CREATE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO net.calls (url, headers, body) VALUES (url, headers, body);
  SELECT 1::bigint
$$;
CREATE OR REPLACE FUNCTION public.makesafe_cron_enabled() RETURNS boolean
  LANGUAGE sql AS $$ SELECT true $$;
SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile');
SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile_inventory');
SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile&mode=D3');
SELECT public.trigger_makesafe_reconcile('makesafe_email_canary');
SELECT public.trigger_makesafe_status_canary();
DO $$
DECLARE
  base text := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=';
  got text[];
  c record;
BEGIN
  SELECT array_agg(url ORDER BY n) INTO got FROM net.calls;
  IF got IS DISTINCT FROM ARRAY[
       base || 'makesafe_email_reconcile',
       base || 'makesafe_email_reconcile_inventory',
       base || 'makesafe_email_reconcile&mode=D3',
       base || 'makesafe_email_canary',
       base || 'makesafe_status_canary'] THEN
    RAISE EXCEPTION 'contract: the crons posted %', got;
  END IF;
  FOR c IN SELECT * FROM net.calls LOOP
    IF c.headers IS DISTINCT FROM jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || public.sw_service_key())
       OR c.body IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'contract: % did not post Bearer sw_service_key() with an empty body', c.url;
    END IF;
  END LOOP;
END $$;
ROLLBACK;
