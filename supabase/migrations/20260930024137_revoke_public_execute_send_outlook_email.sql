-- Close the public path to owner-rights Outlook sends.
--
-- public.send_outlook_email is SECURITY DEFINER, fires the send-outlook-email
-- edge function with the service-role key from _sw_service_key(), and so sends
-- mail as the company to any address with any body and attachment URL.
-- Production grants EXECUTE on both live overloads to anon and authenticated,
-- and the anon key is public. This is the same lockdown
-- 20260930023008_revoke_public_execute_service_key_functions.sql applied to
-- the other _sw_service_key() callers.
--
-- Callers are unaffected: no repo or secureworks-ux code calls it through
-- PostgREST RPC, no migration calls it from SQL, and its documented use is
-- Cowork via execute_sql, which runs as postgres. service_role keeps EXECUTE.
--
-- Only one overload is in a migration here
-- (20260405000002_send_outlook_email_sql.sql); the other exists in production
-- only, so its signature is not known from the repo. Lock every overload by
-- catalog lookup instead of naming signatures.

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
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, postgres', v_fn);
  END LOOP;

  IF NOT FOUND THEN
    RAISE NOTICE 'public.send_outlook_email is absent; nothing to revoke';
  END IF;
END $$;

-- Fail the migration rather than report a closed hole that is still open, for
-- example when anon inherits EXECUTE through a role membership.
DO $$
DECLARE
  v_fn regprocedure;
  v_role text;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'send_outlook_email'
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '% can still execute %', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;
END $$;
