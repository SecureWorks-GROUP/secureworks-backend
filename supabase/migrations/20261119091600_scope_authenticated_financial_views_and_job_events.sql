-- Scope signed-in access on four financial summary views and on job_events
-- reads.
--
-- 1. Views public.job_financials, public.aged_receivables,
--    public.monthly_revenue and public.monthly_costs (each one that exists).
--    They run with their owner's rights. Every privilege anon, PUBLIC and
--    authenticated hold on them, table and column, is removed. service_role
--    keeps (or is given) SELECT. Their readers are edge functions, which use
--    the service role; no signed-in browser reads them directly.
--
-- 2. public.job_events.
--    * Row level security is switched on if it is off.
--    * Every permissive read rule (FOR SELECT) that applies to PUBLIC, anon or
--      authenticated is replaced by job_events_office_read: TO authenticated,
--      the event's job is in the caller's company (public.auth_org_id()) and
--      the caller's users.role is admin, owner, ops_manager, sales or
--      sales_manager, the office set of 20261119090600_job_documents_read_rules.
--    * Insert rules are not changed, so a signed-in insert for a job in the
--      caller's company still succeeds. It needs no read rule (no RETURNING).
--    * Every privilege anon and PUBLIC hold, table and column, is removed.
--      authenticated and service_role grants are not changed.
--    * A permissive rule FOR ALL that applies to PUBLIC, anon or authenticated
--      would also grant reads; the migration refuses rather than guess how to
--      split it.
--
-- Every grant removed or added, every rule dropped or created and the row
-- security switch are recorded in public.financial_read_access_changes, which
-- supabase/rollbacks/20261119091600_scope_authenticated_financial_views_and_job_events_down.sql
-- reads to restore exactly what was there. Rule expressions are recorded with
-- every name schema-qualified. A second apply finds nothing to change and
-- records nothing. The migration fails closed: if any of the checks at the end
-- does not hold, nothing is kept.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'scope financial reads: roles anon, authenticated and service_role must exist';
  END IF;
  IF to_regclass('public.job_events') IS NOT NULL THEN
    IF to_regclass('public.jobs') IS NULL OR to_regclass('public.users') IS NULL THEN
      RAISE EXCEPTION 'scope financial reads: public.jobs or public.users is missing';
    END IF;
    IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.auth_org_id()') IS NULL THEN
      RAISE EXCEPTION 'scope financial reads: auth.uid() or public.auth_org_id() is missing';
    END IF;
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.financial_read_access_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  relation text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('grant', 'policy', 'row_security')),
  change text NOT NULL CHECK (change IN ('revoked', 'granted', 'dropped', 'created', 'enabled')),
  column_name text,
  grantee text CHECK (grantee IN ('anon', 'PUBLIC', 'authenticated', 'service_role')),
  privilege text CHECK (privilege IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')),
  policy_name text,
  policy_command text CHECK (policy_command IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL')),
  policy_permissive boolean,
  policy_roles text[],
  policy_using text,
  policy_check text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'grant') = (grantee IS NOT NULL AND privilege IS NOT NULL)),
  CHECK ((kind = 'policy') = (policy_name IS NOT NULL))
);
ALTER TABLE public.financial_read_access_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.financial_read_access_changes FROM PUBLIC, anon, authenticated, service_role;
DO $seq$
BEGIN
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',
                 pg_get_serial_sequence('public.financial_read_access_changes', 'id'));
END
$seq$;

COMMENT ON TABLE public.financial_read_access_changes IS
  'Grants, row rules and row security changed by 20261119091600_scope_authenticated_financial_views_and_job_events. Read by its rollback. Owner only.';

DO $scope$
DECLARE
  v_view text;
  v_rel regclass;
  v_role text;
  g record;
  p record;
  v_anon oid := to_regrole('anon');
  v_auth oid := to_regrole('authenticated');
  v_left text;
  v_path text := current_setting('search_path');
  v_had text[] := ARRAY[]::text[];
BEGIN
  -- Rule expressions and roles are read with only pg_catalog on the path, so
  -- every name in the recorded text is schema-qualified.
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);

  -- 1. The four financial summary views.
  FOREACH v_view IN ARRAY ARRAY['public.aged_receivables', 'public.job_financials',
                                'public.monthly_costs', 'public.monthly_revenue'] LOOP
    v_rel := to_regclass(v_view);
    CONTINUE WHEN v_rel IS NULL;

    FOR g IN
      SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' WHEN v_anon THEN 'anon' ELSE 'authenticated' END AS grantee,
             a.privilege_type
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = v_rel AND a.grantee IN (0, v_anon, v_auth)
      ORDER BY 1, 2
    LOOP
      INSERT INTO public.financial_read_access_changes (relation, kind, change, grantee, privilege)
      VALUES (v_view, 'grant', 'revoked', g.grantee, g.privilege_type);
    END LOOP;

    FOR g IN
      SELECT DISTINCT at.attname::text AS column_name,
             CASE a.grantee WHEN 0 THEN 'PUBLIC' WHEN v_anon THEN 'anon' ELSE 'authenticated' END AS grantee,
             a.privilege_type
      FROM pg_attribute at
      CROSS JOIN LATERAL aclexplode(at.attacl) a
      WHERE at.attrelid = v_rel AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL
        AND a.grantee IN (0, v_anon, v_auth)
      ORDER BY 1, 2, 3
    LOOP
      INSERT INTO public.financial_read_access_changes (relation, kind, change, column_name, grantee, privilege)
      VALUES (v_view, 'grant', 'revoked', g.column_name, g.grantee, g.privilege_type);
      EXECUTE format('REVOKE %s (%I) ON TABLE %s FROM %s', g.privilege_type, g.column_name, v_view,
                     CASE g.grantee WHEN 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.grantee) END);
    END LOOP;

    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated', v_view);

    IF NOT has_table_privilege('service_role', v_rel, 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON TABLE %s TO service_role', v_view);
      INSERT INTO public.financial_read_access_changes (relation, kind, change, grantee, privilege)
      VALUES (v_view, 'grant', 'granted', 'service_role', 'SELECT');
    END IF;
  END LOOP;

  -- 2. job_events.
  v_rel := to_regclass('public.job_events');
  IF v_rel IS NOT NULL THEN
    -- The signed-in and server privileges held now; each must survive.
    SELECT coalesce(array_agg(format('%s %s', r.role_name, q.priv) ORDER BY r.role_name, q.priv), ARRAY[]::text[]) INTO v_had
    FROM (VALUES ('authenticated'), ('service_role')) AS r(role_name)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS q(priv)
    WHERE has_table_privilege(r.role_name, v_rel, q.priv);

    IF EXISTS (SELECT 1 FROM pg_policy pol
               WHERE pol.polrelid = v_rel AND pol.polpermissive AND pol.polcmd = '*'
                 AND (0::oid = ANY (pol.polroles) OR v_anon = ANY (pol.polroles) OR v_auth = ANY (pol.polroles))) THEN
      RAISE EXCEPTION 'scope financial reads: public.job_events has a permissive rule for all commands that applies to PUBLIC, anon or authenticated';
    END IF;

    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel) THEN
      ALTER TABLE public.job_events ENABLE ROW LEVEL SECURITY;
      INSERT INTO public.financial_read_access_changes (relation, kind, change)
      VALUES ('public.job_events', 'row_security', 'enabled');
    END IF;

    FOR p IN
      SELECT pol.polname::text AS name,
             pol.polpermissive AS permissive,
             ARRAY(SELECT CASE r WHEN 0 THEN 'public' ELSE r::regrole::text END
                   FROM unnest(pol.polroles) WITH ORDINALITY AS u(r, o) ORDER BY o) AS roles,
             pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
             pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
      FROM pg_policy pol
      WHERE pol.polrelid = v_rel AND pol.polpermissive AND pol.polcmd = 'r'
        AND pol.polname <> 'job_events_office_read'
        AND (0::oid = ANY (pol.polroles) OR v_anon = ANY (pol.polroles) OR v_auth = ANY (pol.polroles))
      ORDER BY pol.polname COLLATE "C"
    LOOP
      INSERT INTO public.financial_read_access_changes
        (relation, kind, change, policy_name, policy_command, policy_permissive, policy_roles, policy_using, policy_check)
      VALUES ('public.job_events', 'policy', 'dropped', p.name, 'SELECT', p.permissive, p.roles, p.using_expr, p.check_expr);
      EXECUTE format('DROP POLICY %I ON public.job_events', p.name);
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_rel AND polname = 'job_events_office_read') THEN
      CREATE POLICY job_events_office_read
        ON public.job_events
        AS PERMISSIVE
        FOR SELECT
        TO authenticated
        USING (
          EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_events.job_id AND j.org_id = public.auth_org_id())
          AND EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.id = auth.uid() AND lower(u.role) IN ('admin', 'owner', 'ops_manager', 'sales', 'sales_manager')
          )
        );
      INSERT INTO public.financial_read_access_changes
        (relation, kind, change, policy_name, policy_command, policy_permissive, policy_roles)
      VALUES ('public.job_events', 'policy', 'created', 'job_events_office_read', 'SELECT', true, ARRAY['authenticated']);
    END IF;

    FOR g IN
      SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE 'anon' END AS grantee, a.privilege_type
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = v_rel AND a.grantee IN (0, v_anon)
      ORDER BY 1, 2
    LOOP
      -- What PUBLIC gave the signed-in and server roles they keep as their own.
      IF g.grantee = 'PUBLIC' AND g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE') THEN
        FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_class c
                         CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                         WHERE c.oid = v_rel AND a.grantee = to_regrole(v_role) AND a.privilege_type = g.privilege_type) THEN
            EXECUTE format('GRANT %s ON TABLE public.job_events TO %I', g.privilege_type, v_role);
            INSERT INTO public.financial_read_access_changes (relation, kind, change, grantee, privilege)
            VALUES ('public.job_events', 'grant', 'granted', v_role, g.privilege_type);
          END IF;
        END LOOP;
      END IF;
      INSERT INTO public.financial_read_access_changes (relation, kind, change, grantee, privilege)
      VALUES ('public.job_events', 'grant', 'revoked', g.grantee, g.privilege_type);
    END LOOP;

    FOR g IN
      SELECT DISTINCT at.attname::text AS column_name,
             CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE 'anon' END AS grantee,
             a.privilege_type
      FROM pg_attribute at
      CROSS JOIN LATERAL aclexplode(at.attacl) a
      WHERE at.attrelid = v_rel AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL
        AND a.grantee IN (0, v_anon)
      ORDER BY 1, 2, 3
    LOOP
      IF g.grantee = 'PUBLIC' AND g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE') THEN
        FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_class c
                         CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                         WHERE c.oid = v_rel AND a.grantee = to_regrole(v_role) AND a.privilege_type = g.privilege_type)
             AND NOT EXISTS (SELECT 1 FROM pg_attribute at
                             CROSS JOIN LATERAL aclexplode(at.attacl) a
                             WHERE at.attrelid = v_rel AND at.attname = g.column_name AND at.attacl IS NOT NULL
                               AND a.grantee = to_regrole(v_role) AND a.privilege_type = g.privilege_type) THEN
            EXECUTE format('GRANT %s (%I) ON TABLE public.job_events TO %I', g.privilege_type, g.column_name, v_role);
            INSERT INTO public.financial_read_access_changes (relation, kind, change, column_name, grantee, privilege)
            VALUES ('public.job_events', 'grant', 'granted', g.column_name, v_role, g.privilege_type);
          END IF;
        END LOOP;
      END IF;
      INSERT INTO public.financial_read_access_changes (relation, kind, change, column_name, grantee, privilege)
      VALUES ('public.job_events', 'grant', 'revoked', g.column_name, g.grantee, g.privilege_type);
      EXECUTE format('REVOKE %s (%I) ON TABLE public.job_events FROM %s', g.privilege_type, g.column_name,
                     CASE g.grantee WHEN 'PUBLIC' THEN 'PUBLIC' ELSE 'anon' END);
    END LOOP;

    REVOKE ALL ON TABLE public.job_events FROM PUBLIC, anon;
  END IF;

  -- Fail closed: no view keeps a privilege for anon, PUBLIC or authenticated,
  -- and service_role can read each.
  SELECT string_agg(v.n, ', ' ORDER BY v.n COLLATE "C") INTO v_left
  FROM unnest(ARRAY['public.aged_receivables', 'public.job_financials',
                    'public.monthly_costs', 'public.monthly_revenue']) AS v(n)
  WHERE to_regclass(v.n) IS NOT NULL
    AND (EXISTS (SELECT 1 FROM pg_class k
                 CROSS JOIN LATERAL aclexplode(coalesce(k.relacl, acldefault('r', k.relowner))) a
                 WHERE k.oid = to_regclass(v.n) AND a.grantee IN (0, v_anon, v_auth))
         OR EXISTS (SELECT 1 FROM pg_attribute at
                    CROSS JOIN LATERAL aclexplode(at.attacl) a
                    WHERE at.attrelid = to_regclass(v.n) AND at.attacl IS NOT NULL
                      AND a.grantee IN (0, v_anon, v_auth))
         OR NOT has_table_privilege('service_role', to_regclass(v.n), 'SELECT'));
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'scope financial reads: a view is still reachable by a signed-in or anonymous caller, or not by the server role: %', v_left;
  END IF;

  IF v_rel IS NOT NULL THEN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel) THEN
      RAISE EXCEPTION 'scope financial reads: row level security is off on public.job_events';
    END IF;
    SELECT string_agg(pol.polname, ', ' ORDER BY pol.polname COLLATE "C") INTO v_left
    FROM pg_policy pol
    WHERE pol.polrelid = v_rel AND pol.polpermissive AND pol.polcmd IN ('r', '*')
      AND (0::oid = ANY (pol.polroles) OR v_anon = ANY (pol.polroles) OR v_auth = ANY (pol.polroles))
      AND NOT (pol.polname = 'job_events_office_read' AND pol.polcmd = 'r' AND pol.polroles = ARRAY[v_auth]);
    IF v_left IS NOT NULL THEN
      RAISE EXCEPTION 'scope financial reads: another read rule on public.job_events applies to signed-in or anonymous callers: %', v_left;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class k
               CROSS JOIN LATERAL aclexplode(coalesce(k.relacl, acldefault('r', k.relowner))) a
               WHERE k.oid = v_rel AND a.grantee IN (0, v_anon))
       OR EXISTS (SELECT 1 FROM pg_attribute at
                  CROSS JOIN LATERAL aclexplode(at.attacl) a
                  WHERE at.attrelid = v_rel AND at.attacl IS NOT NULL AND a.grantee IN (0, v_anon)) THEN
      RAISE EXCEPTION 'scope financial reads: anon or PUBLIC still holds a privilege on public.job_events';
    END IF;
    SELECT string_agg(h, ', ') INTO v_left
    FROM unnest(v_had) AS h
    WHERE NOT has_table_privilege(split_part(h, ' ', 1), v_rel, split_part(h, ' ', 2));
    IF v_left IS NOT NULL THEN
      RAISE EXCEPTION 'scope financial reads: a signed-in or server role lost a privilege on public.job_events: %', v_left;
    END IF;
  END IF;

  PERFORM set_config('search_path', v_path, true);
END
$scope$;
