-- Rollback for 20261002150000_exec_sql_revoke_public.sql.
-- Run ONLY on the owner's explicit word: it reopens exec_sql to the public
-- anon key, which can then read every table as postgres.
--
-- Re-grants the grants exec_sql held before the revoke: EXECUTE to PUBLIC,
-- anon and authenticated (the 2 Oct read-only check found anon and
-- authenticated; PUBLIC is the Postgres default on CREATE FUNCTION and no
-- repo migration ever revoked it). Compare against the "proacl before" NOTICE
-- the forward migration wrote to the apply log and drop PUBLIC from the
-- statement below if that line did not show "=X/postgres".
-- service_role keeps the explicit grant the forward migration added; it held
-- EXECUTE before too, so that is not a change in who can call it.

DO $exec_sql_rollback$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'exec_sql'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC, anon, authenticated', v_fn);
  END LOOP;
END
$exec_sql_rollback$;
