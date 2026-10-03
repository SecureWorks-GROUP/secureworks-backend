-- Close the public-key (anon) read of public.business_events.
--
-- Why: 20260316000005_intelligence_layer.sql:36 created
--   CREATE POLICY "select_all" ON business_events FOR SELECT USING (true);
-- with no TO clause, so it applies to PUBLIC. With the anon role holding
-- SELECT, the anon key printed in the Ops, Trade, Sale, fence and patio pages
-- can read every row, including SMS bodies (payload / body_preview).
--
-- What this changes:
--   1. Drops select_all.
--   2. Adds business_events_staff_read: SELECT for signed-in office staff only
--      (users.role admin, owner, ops_manager, sales, sales_manager), through a
--      SECURITY DEFINER helper so the check does not depend on the users
--      table's own row rules. 'estimator' is deliberately NOT included: it is
--      the role ghl-proxy get_profile auto-assigns to any brand-new signed-in
--      account, so including it would hand the read to anyone who can create
--      an account. Trades (installer, lead_installer, crew) read nothing here.
--   3. Revokes SELECT from anon (and PUBLIC). authenticated and service_role
--      keep an explicit SELECT grant; service_role bypasses row rules and is
--      unaffected.
--   4. Revokes TRUNCATE, UPDATE, DELETE, REFERENCES and TRIGGER from anon
--      (and PUBLIC), so the public key holds INSERT and nothing else here.
--      Production grants anon every table privilege through Supabase's
--      default privileges (read-only check, 2 Oct 2026). Row rules already
--      stop anon UPDATE and DELETE (no policy allows them), but TRUNCATE
--      ignores row rules entirely. No anon caller updates, deletes or
--      truncates this table; the only INSERT trigger
--      (attribute_business_event) is SECURITY DEFINER, so an anon insert
--      never needs UPDATE.
--   5. Revokes TRUNCATE, REFERENCES and TRIGGER from authenticated. No staff
--      surface truncates, and REFERENCES / TRIGGER are only usable through
--      DDL, which no signed-in surface can issue. authenticated keeps
--      SELECT, INSERT, UPDATE and DELETE; UPDATE and DELETE stay inert
--      under row rules (no policy) and are left for a separate item.
--
-- What this deliberately does NOT change:
--   - INSERT: the insert_only policy (PUBLIC, WITH CHECK true) and
--     "Allow scope decision inserts from tools" (anon) stay, and anon keeps
--     its INSERT grant. The patio tool's logScopeDecision posts with
--     Prefer: return=minimal, which PostgREST sends as INSERT ... RETURNING 1;
--     that needs no SELECT privilege and no SELECT policy, so it keeps
--     working. An INSERT that asks for the row back (return=representation)
--     as anon is refused after this change; no caller does that.
--   - Other routes to the same rows: the anon-callable _sw_service_key()
--     (hands out the service-role key) and the live-only exec_sql (runs SQL
--     as postgres) are separate items; this change does not close them.
--   - The BEFORE INSERT attribution trigger: SECURITY DEFINER, unaffected.
--
-- Callers and the order they must move in: see the merge request
-- "DO NOT MERGE before the owner's yes: close the public read of
-- business_events". The Jarvis memory reader (secureworks-jarvis
-- src/memory/retriever.ts) reads this table with SUPABASE_ANON_KEY and must
-- move to a server key BEFORE this applies.
--
-- Rollback: supabase/rollbacks/20261002190000_business_events_close_anon_read_down.sql

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF to_regclass('public.business_events') IS NULL THEN
    RAISE EXCEPTION 'business_events_close_anon_read: public.business_events is missing';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'business_events_close_anon_read: auth.uid() is missing';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'business_events_close_anon_read: public.users is missing';
  END IF;
END
$pre$;

-- Production already has row level security on (read-only check, 2 Oct 2026);
-- this keeps a migration-provisioned database in the same state.
ALTER TABLE public.business_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.business_events_staff_reader()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = auth.uid()
      AND lower(u.role::text) IN ('admin', 'owner', 'ops_manager', 'sales', 'sales_manager')
  );
$$;

COMMENT ON FUNCTION public.business_events_staff_reader() IS
  'True when the signed-in caller is office staff allowed to read business_events. estimator is excluded because get_profile auto-assigns it to new accounts.';

REVOKE ALL ON FUNCTION public.business_events_staff_reader() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.business_events_staff_reader() TO authenticated, service_role;

DROP POLICY IF EXISTS select_all ON public.business_events;

CREATE POLICY business_events_staff_read
  ON public.business_events
  FOR SELECT
  TO authenticated
  USING ((SELECT public.business_events_staff_reader()));

REVOKE SELECT ON TABLE public.business_events FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.business_events TO authenticated, service_role;

REVOKE TRUNCATE, UPDATE, DELETE, REFERENCES, TRIGGER
  ON TABLE public.business_events FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.business_events FROM authenticated;

DO $post$
BEGIN
  IF has_table_privilege('anon', 'public.business_events', 'SELECT')
     OR has_any_column_privilege('anon', 'public.business_events', 'SELECT') THEN
    RAISE EXCEPTION 'business_events_close_anon_read: anon can still SELECT business_events';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'business_events'
      AND cmd IN ('SELECT', 'ALL')
      AND (roles && ARRAY['public', 'anon']::name[])
  ) THEN
    RAISE EXCEPTION 'business_events_close_anon_read: a SELECT policy still applies to anon or PUBLIC';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.business_events', 'SELECT') THEN
    RAISE EXCEPTION 'business_events_close_anon_read: authenticated lost SELECT';
  END IF;
  IF has_table_privilege('anon', 'public.business_events', 'TRUNCATE, UPDATE, DELETE, REFERENCES, TRIGGER')
     OR has_any_column_privilege('anon', 'public.business_events', 'UPDATE, REFERENCES') THEN
    RAISE EXCEPTION 'business_events_close_anon_read: anon still holds a privilege beyond INSERT';
  END IF;
  IF has_table_privilege('authenticated', 'public.business_events', 'TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'business_events_close_anon_read: authenticated still holds TRUNCATE, REFERENCES or TRIGGER';
  END IF;
END
$post$;
