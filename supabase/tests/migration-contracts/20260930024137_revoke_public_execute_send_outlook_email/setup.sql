-- Minimal pre-migration surface: the Supabase API roles, the key helper
-- chain, the audit table send_outlook_email writes, the repo overload from
-- 20260405000002 and a stand-in for the production-only overload, both in
-- their production grant state (EXECUTE to PUBLIC, anon, authenticated and
-- service_role). Every object is created only when an earlier registered case
-- has not already made it, so this case stands on its own without changing a
-- shape another case relies on. The pg_net stand-in lives in contract.sql
-- inside a rolled-back transaction, because an earlier case's contract
-- creates the net schema itself.
-- This is test infrastructure, not the production schema.

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

DO $outer$
BEGIN
  IF to_regprocedure('public.sw_service_key()') IS NULL THEN
    CREATE FUNCTION public.sw_service_key() RETURNS text
      LANGUAGE sql AS $$ SELECT 'contract-fixture-key' $$;
  END IF;

  -- Production shape since 20260930023008: an INVOKER alias of the
  -- postgres-only accessor, reachable only through an owner-rights caller.
  IF to_regprocedure('public._sw_service_key()') IS NULL THEN
    CREATE FUNCTION public._sw_service_key() RETURNS text AS $$
    BEGIN
      RETURN public.sw_service_key();
    END;
    $$ LANGUAGE plpgsql STABLE SECURITY INVOKER;
  END IF;
END $outer$;

CREATE TABLE IF NOT EXISTS public.outbound_message_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel varchar NOT NULL,
  recipient_id varchar,
  recipient_type varchar,
  message_content text,
  metadata jsonb,
  status varchar NOT NULL DEFAULT 'queued',
  sent_at timestamptz
);

-- The repo body, with the project URL swapped for a non-routable host.
CREATE FUNCTION public.send_outlook_email(
  p_to text,
  p_subject text,
  p_html_body text,
  p_from text DEFAULT 'marnin@secureworkswa.com.au',
  p_cc text DEFAULT NULL,
  p_attachment_url text DEFAULT NULL,
  p_attachment_name text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_queue_id uuid;
BEGIN
  INSERT INTO outbound_message_queue (channel, recipient_id, recipient_type, message_content, metadata, status)
  VALUES ('outlook_email', p_to, 'email_address', p_subject || ': ' || LEFT(p_html_body, 200),
    jsonb_build_object('from', p_from, 'subject', p_subject, 'source', 'cowork_sql'),
    'processing')
  RETURNING id INTO v_queue_id;

  PERFORM net.http_post(
    url := 'https://example.invalid/functions/v1/send-outlook-email',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('from', p_from, 'to', p_to, 'subject', p_subject, 'htmlBody', p_html_body)
  );

  UPDATE outbound_message_queue SET status = 'sent', sent_at = now() WHERE id = v_queue_id;
  RETURN v_queue_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Stand-in for the production-only overload, which the migration can only
-- reach through its catalog sweep. No migration defines it; the signature is
-- the one the 2 Oct 2026 read-only production check recorded (see the
-- 20261002200000_sec_group_a_revoke setup), so that later case finds this
-- overload instead of adding a third.
CREATE FUNCTION public.send_outlook_email(
  p_from_email text,
  p_to_email text,
  p_subject text,
  p_html_body text,
  p_cc text,
  p_attachment_urls jsonb
) RETURNS uuid AS $$ SELECT NULL::uuid $$ LANGUAGE sql SECURITY DEFINER;

DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'send_outlook_email'
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO PUBLIC, anon, authenticated, service_role',
      v_fn
    );
  END LOOP;
END $$;
