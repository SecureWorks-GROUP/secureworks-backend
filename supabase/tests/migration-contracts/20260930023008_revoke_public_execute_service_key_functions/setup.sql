-- Minimal pre-migration surface: the Supabase API roles, a Vault stand-in, a
-- recording pg_net stand-in, the fail-closed accessor from 20260731081411 and
-- the nine functions in their production grant state (EXECUTE to PUBLIC plus
-- the anon/authenticated/service_role default-privilege grants).
-- This is test infrastructure, not a replacement for the production schema.
-- The Vault value is a fixture shaped like a JWT, not a key.

DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', v_role);
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets (
  name text PRIMARY KEY,
  decrypted_secret text
);
INSERT INTO vault.decrypted_secrets (name, decrypted_secret)
VALUES ('service_role_key', 'eyJmaXh0dXJl.bm90LWEta2V5.Y29udHJhY3Q');

CREATE SCHEMA net;
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

REVOKE ALL ON FUNCTION public.sw_service_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sw_service_key() FROM anon;
REVOKE ALL ON FUNCTION public.sw_service_key() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sw_service_key() TO postgres;

-- Production shape: a literal returned by an IMMUTABLE function.
CREATE OR REPLACE FUNCTION public._sw_service_key() RETURNS text AS $$
BEGIN
  RETURN 'contract-fixture-legacy-literal';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.trigger_daily_digest() RETURNS void AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://example.invalid/functions/v1/daily-digest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE FUNCTION public.send_ghl_sms(
  p_contact_id text,
  p_message text,
  p_job_id uuid DEFAULT NULL
) RETURNS uuid AS $$ SELECT NULL::uuid $$ LANGUAGE sql SECURITY DEFINER;

CREATE FUNCTION public.send_ghl_email(
  p_contact_id text,
  p_subject text,
  p_html_body text,
  p_job_id uuid DEFAULT NULL
) RETURNS uuid AS $$ SELECT NULL::uuid $$ LANGUAGE sql SECURITY DEFINER;

CREATE FUNCTION public.process_outbound_queue() RETURNS integer AS $$ SELECT 0 $$
  LANGUAGE sql SECURITY DEFINER;
CREATE FUNCTION public.trigger_monitor_inbox() RETURNS void AS $$ SELECT $$
  LANGUAGE sql SECURITY DEFINER;
CREATE FUNCTION public.fn_process_payment_events() RETURNS void AS $$ SELECT $$
  LANGUAGE sql;

-- Live-only functions (no repo migration), plus an overload the migration can
-- only reach through its catalog sweep.
CREATE FUNCTION public.trigger_generate_nudges() RETURNS void AS $$ SELECT $$
  LANGUAGE sql SECURITY DEFINER;
CREATE FUNCTION public.trigger_generate_nudges(p_limit integer) RETURNS void AS $$ SELECT $$
  LANGUAGE sql SECURITY DEFINER;
CREATE FUNCTION public.trigger_batch_intelligence() RETURNS void AS $$ SELECT $$
  LANGUAGE sql SECURITY DEFINER;

DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
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
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO PUBLIC, anon, authenticated, service_role',
      v_fn
    );
  END LOOP;
END $$;
