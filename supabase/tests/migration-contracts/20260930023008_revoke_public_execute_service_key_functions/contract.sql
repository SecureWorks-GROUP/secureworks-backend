-- 1. No public role holds EXECUTE on any overload of the nine functions, and
--    service_role keeps the callers.
DO $$
DECLARE
  v_fn regprocedure;
  v_name text;
  v_role text;
  v_count integer := 0;
BEGIN
  FOR v_fn, v_name IN
    SELECT p.oid::regprocedure, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         '_sw_service_key', 'send_ghl_sms', 'send_ghl_email',
         'process_outbound_queue', 'trigger_daily_digest',
         'trigger_monitor_inbox', 'trigger_generate_nudges',
         'trigger_batch_intelligence', 'fn_process_payment_events'
       )
  LOOP
    v_count := v_count + 1;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'contract: % can still execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF v_name <> '_sw_service_key'
       AND NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract: service_role lost EXECUTE on %', v_fn;
    END IF;
  END LOOP;

  IF v_count <> 10 THEN
    RAISE EXCEPTION 'contract: expected 10 guarded overloads, found %', v_count;
  END IF;
END $$;

-- 2. The grants hold at call time, not only in the catalog.
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM public._sw_service_key();
  RAISE EXCEPTION 'contract: anon executed public._sw_service_key()';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
DO $$
BEGIN
  PERFORM public.send_ghl_sms('contact', 'message');
  RAISE EXCEPTION 'contract: anon executed public.send_ghl_sms()';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.send_ghl_email('contact', 'subject', '<p>body</p>');
  RAISE EXCEPTION 'contract: authenticated executed public.send_ghl_email()';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
ROLLBACK;

-- 3-5 need Vault, pg_net and the fail-closed accessor from 20260731081411.
-- Stand them in and roll them back so no other case sees them. The Vault
-- value is a fixture shaped like a JWT, not a key.
BEGIN;
CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets (
  name text PRIMARY KEY,
  decrypted_secret text
);
INSERT INTO vault.decrypted_secrets (name, decrypted_secret)
VALUES ('service_role_key', 'eyJmaXh0dXJl.bm90LWEta2V5.Y29udHJhY3Q');

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net.contract_calls (
  id bigserial PRIMARY KEY,
  url text NOT NULL,
  headers jsonb NOT NULL,
  body jsonb NOT NULL
);
CREATE FUNCTION net.http_post(
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint AS $$
  INSERT INTO net.contract_calls (url, headers, body)
  VALUES (url, headers, body)
  RETURNING id;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text AS $$
DECLARE
  v_key text;
BEGIN
  SELECT regexp_replace(decrypted_secret, '\s', '', 'g')
    INTO v_key
    FROM vault.decrypted_secrets
   WHERE name = 'service_role_key'
   LIMIT 1;

  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION
      'sw_service_key: vault secret "service_role_key" is missing or empty';
  END IF;

  IF v_key !~ '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION
      'sw_service_key: vault secret "service_role_key" is not a well-formed JWT';
  END IF;

  RETURN v_key;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = public, pg_temp;

-- 3. The key helper carries no literal and returns the Vault key.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public._sw_service_key()'::regprocedure);
BEGIN
  IF v_def ~ 'eyJ' OR v_def ~ 'contract-fixture-legacy-literal' THEN
    RAISE EXCEPTION 'contract: public._sw_service_key() still returns a literal';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public._sw_service_key()'::regprocedure) = 'i' THEN
    RAISE EXCEPTION 'contract: public._sw_service_key() is still IMMUTABLE';
  END IF;
  IF public._sw_service_key() IS DISTINCT FROM
     (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key') THEN
    RAISE EXCEPTION 'contract: public._sw_service_key() does not return the Vault key';
  END IF;
END $$;

-- 4. An owner-rights caller still reaches the key for a non-public invoker,
--    which is the path pg_cron and the SECURITY DEFINER triggers take.
SET LOCAL ROLE service_role;
SELECT public.trigger_daily_digest();
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM net.contract_calls c
     WHERE c.url LIKE '%/daily-digest'
       AND c.headers->>'Authorization' = 'Bearer ' || (
         SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'
       )
  ) THEN
    RAISE EXCEPTION 'contract: trigger_daily_digest() did not send the Vault key';
  END IF;
END $$;

-- 5. With Vault empty the helper fails closed instead of returning anything.
DELETE FROM vault.decrypted_secrets WHERE name = 'service_role_key';
DO $$
BEGIN
  PERFORM public._sw_service_key();
  RAISE EXCEPTION 'contract: public._sw_service_key() returned without a Vault key';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'sw_service_key: vault secret "service_role_key" is missing or empty' THEN
    RAISE;
  END IF;
END $$;
ROLLBACK;
