-- Close the public path to the service-role key and to owner-rights GHL sends.
--
-- Production grants EXECUTE to anon and authenticated (the anon key is public)
-- on public._sw_service_key(), which returned the service-role key as a
-- literal, and on SECURITY DEFINER callers that send SMS/email or fire edge
-- functions with that key. This mirrors the public.sw_service_key() lockdown in
-- 20260731081411_remove_sw_service_key_fallback.sql.
--
-- Callers are unaffected: pg_cron jobs run as postgres, every repo caller of
-- _sw_service_key() is SECURITY DEFINER owned by postgres, and no repo code
-- calls these functions through PostgREST RPC. service_role keeps EXECUTE on
-- the callers, matching the repo's cron-trigger lockdown pattern
-- (20260614000002, 20260619041625). The key helper gains no service_role
-- grant; one it already holds is left alone, as it is that role's own key.
--
-- This does not rotate the key. The literal stays in older migration files
-- and git history until rotation.

-- _sw_service_key() now delegates to the fail-closed Vault accessor, so the
-- live function body no longer carries the key. It is SECURITY INVOKER on
-- purpose: a caller must itself be able to execute public.sw_service_key()
-- (postgres only), so a stray future re-grant of this wrapper cannot leak the
-- key. STABLE, not IMMUTABLE, because it reads Vault.
CREATE OR REPLACE FUNCTION public._sw_service_key() RETURNS text AS $$
BEGIN
  RETURN public.sw_service_key();
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public._sw_service_key() IS
  'Legacy alias of public.sw_service_key(): returns the Vault service-role key and fails closed when it is unavailable. postgres only.';

REVOKE ALL ON FUNCTION public._sw_service_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._sw_service_key() FROM anon;
REVOKE ALL ON FUNCTION public._sw_service_key() FROM authenticated;
GRANT EXECUTE ON FUNCTION public._sw_service_key() TO postgres;

-- Signatures from 20260405000001_cowork_sql_functions.sql,
-- 20260405000003_inbox_events.sql and 20260406000001_debt_automation.sql.
REVOKE ALL ON FUNCTION public.send_ghl_sms(text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.send_ghl_email(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_outbound_queue() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_daily_digest() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_monitor_inbox() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_process_payment_events() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.send_ghl_sms(text, text, uuid) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.send_ghl_email(text, text, text, uuid) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.process_outbound_queue() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.trigger_daily_digest() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.trigger_monitor_inbox() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.fn_process_payment_events() TO service_role, postgres;

-- trigger_generate_nudges and trigger_batch_intelligence exist in production
-- but in no migration here, so their signatures are not known from the repo
-- and a migration-provisioned database does not have them. Lock every
-- overload of every named function by catalog lookup instead; this also
-- catches any live-only overload of the functions above.
DO $$
DECLARE
  v_fn regprocedure;
  v_name text;
BEGIN
  FOR v_fn, v_name IN
    SELECT p.oid::regprocedure, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         '_sw_service_key',
         'send_ghl_sms',
         'send_ghl_email',
         'process_outbound_queue',
         'trigger_daily_digest',
         'trigger_monitor_inbox',
         'trigger_generate_nudges',
         'trigger_batch_intelligence',
         'fn_process_payment_events'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    IF v_name = '_sw_service_key' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', v_fn);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, postgres', v_fn);
    END IF;
  END LOOP;

  FOREACH v_name IN ARRAY ARRAY['trigger_generate_nudges', 'trigger_batch_intelligence'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = v_name
    ) THEN
      RAISE NOTICE 'public.% is absent; nothing to revoke', v_name;
    END IF;
  END LOOP;
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
       AND p.proname IN (
         '_sw_service_key',
         'send_ghl_sms',
         'send_ghl_email',
         'process_outbound_queue',
         'trigger_daily_digest',
         'trigger_monitor_inbox',
         'trigger_generate_nudges',
         'trigger_batch_intelligence',
         'fn_process_payment_events'
       )
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '% can still execute %', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;
END $$;
