-- Close public.exec_sql to the public key.
--
-- exec_sql(text) is a live-only SECURITY DEFINER function owned by postgres
-- (no repo source) whose body runs EXECUTE 'SELECT jsonb_agg(row_to_json(t))
-- FROM (' || query || ') t'. With EXECUTE held by anon and authenticated, the
-- public anon key printed in page code can read every table as postgres.
--
-- This migration changes privileges only. The function is not dropped and
-- its body is not touched.
--   * EXECUTE is revoked from PUBLIC, anon and authenticated on every
--     public.exec_sql overload.
--   * EXECUTE is granted explicitly to service_role, so a grant it held only
--     through PUBLIC survives the revoke. Its one known caller, the sql-query
--     edge function, calls it with SUPABASE_SERVICE_ROLE_KEY.
--   * The post-check fails the whole apply if anon or authenticated can still
--     execute any overload, or if service_role cannot.
--
-- On a database without exec_sql (fresh migration-only provisioning) this is
-- a no-op. Rollback, only on the owner's word:
-- supabase/rollbacks/20261002180000_exec_sql_revoke_public_down.sql.

DO $exec_sql_revoke$
DECLARE
  v_fn regprocedure;
  v_acl aclitem[];
BEGIN
  FOR v_fn, v_acl IN
    SELECT p.oid::regprocedure, p.proacl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'exec_sql'
  LOOP
    -- Record the pre-apply grants in the apply log so a rollback can be
    -- compared against them.
    RAISE NOTICE 'exec_sql revoke: % proacl before = %', v_fn, v_acl;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$exec_sql_revoke$;

DO $exec_sql_post_check$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'exec_sql'
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'exec_sql revoke post-check: anon can still execute %', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'exec_sql revoke post-check: authenticated can still execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'exec_sql revoke post-check: service_role lost execute on %', v_fn;
    END IF;
  END LOOP;
END
$exec_sql_post_check$;
