-- 1. No public role holds EXECUTE on either overload, and service_role and
--    postgres keep it.
DO $$
DECLARE
  v_fn regprocedure;
  v_role text;
  v_count integer := 0;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'send_outlook_email'
  LOOP
    v_count := v_count + 1;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'contract: % can still execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1
        FROM pg_proc p, aclexplode(p.proacl) a
       WHERE p.oid = v_fn
         AND a.grantee = 0
         AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'contract: PUBLIC still holds EXECUTE on %', v_fn;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['service_role', 'postgres'] LOOP
      IF NOT has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'contract: % lost EXECUTE on %', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'contract: expected 2 guarded overloads, found %', v_count;
  END IF;
END $$;

-- 2. The grants hold at call time for both overloads, not only in the catalog.
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM public.send_outlook_email('to@example.invalid', 'subject', '<p>body</p>');
  RAISE EXCEPTION 'contract: anon executed public.send_outlook_email(text x7)';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
DO $$
BEGIN
  PERFORM public.send_outlook_email('to@example.invalid', 'subject', '<p>body</p>', '[]'::jsonb);
  RAISE EXCEPTION 'contract: anon executed public.send_outlook_email(..., jsonb)';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.send_outlook_email('to@example.invalid', 'subject', '<p>body</p>');
  RAISE EXCEPTION 'contract: authenticated executed public.send_outlook_email(text x7)';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
DO $$
BEGIN
  PERFORM public.send_outlook_email('to@example.invalid', 'subject', '<p>body</p>', '[]'::jsonb);
  RAISE EXCEPTION 'contract: authenticated executed public.send_outlook_email(..., jsonb)';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
ROLLBACK;

-- 3. service_role still sends through the owner-rights path, with the service
--    key, and the audit row is written.
BEGIN;
-- pg_net is absent from the plain PostgreSQL runner. Stand in a recorder with
-- the production net.http_post signature. Rolled back.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE IF NOT EXISTS net.contract_calls (
  id bigserial PRIMARY KEY,
  url text NOT NULL,
  headers jsonb NOT NULL,
  body jsonb NOT NULL
);
DO $outer$
BEGIN
  IF to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
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
  END IF;
END $outer$;
GRANT USAGE ON SCHEMA net TO service_role;
SET LOCAL ROLE service_role;
SELECT public.send_outlook_email('to@example.invalid', 'contract subject', '<p>body</p>');
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM net.contract_calls c
     WHERE c.url LIKE '%/send-outlook-email'
       AND c.body->>'to' = 'to@example.invalid'
       AND c.headers->>'Authorization' = 'Bearer ' || public.sw_service_key()
  ) THEN
    RAISE EXCEPTION 'contract: service_role call did not send the service key to send-outlook-email';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.outbound_message_queue q
     WHERE q.channel = 'outlook_email'
       AND q.recipient_id = 'to@example.invalid'
       AND q.status = 'sent'
  ) THEN
    RAISE EXCEPTION 'contract: service_role call wrote no audit row';
  END IF;
END $$;
ROLLBACK;
