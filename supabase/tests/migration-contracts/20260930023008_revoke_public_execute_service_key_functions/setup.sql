-- Minimal pre-migration surface: the Supabase API roles and the nine
-- functions in their production grant state (EXECUTE to PUBLIC plus the
-- anon/authenticated/service_role default-privilege grants). The Vault,
-- pg_net and public.sw_service_key() stand-ins live in contract.sql inside a
-- rolled-back transaction, because every case shares this database.
-- This is test infrastructure, not a replacement for the production schema.

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
