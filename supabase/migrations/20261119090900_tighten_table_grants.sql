-- Tighten table grants (step one: the anonymous role).
--
-- Removes every privilege the anon role and PUBLIC (which anon inherits) hold,
-- table and column, on each relation in schema public that either role could
-- reach without a sign-in test:
--   * a table with row level security off;
--   * a view, materialized view or foreign table that runs with its owner's
--     rights (not security_invoker);
--   * a table whose permissive policy for public or anon, on the command the
--     role holds a grant for, carries no sign-in test.
-- The set is read from the catalogue when this runs, by
-- public.table_grant_open_relations(), so the file names no relation.
--
-- Where PUBLIC held SELECT, INSERT, UPDATE or DELETE, authenticated and
-- service_role first receive that privilege as their own grant when they do
-- not already hold it, so no signed-in caller and no server caller loses
-- access. Other privileges PUBLIC held are removed without being handed on.
--
-- Not changed here: policies; security_invoker views (they follow their
-- tables); relations outside the picked set; the default privileges that give
-- each new table in public to anon. Those are step two.
--
-- Every grant removed or added is recorded in public.table_grant_changes,
-- which supabase/rollbacks/20261119090900_tighten_table_grants_down.sql reads
-- to restore exactly what was held. A second apply finds nothing to change
-- and records nothing. The migration fails closed: if any picked relation
-- still has a grant to anon or PUBLIC after the revokes (one this role cannot
-- remove), or a signed-in or server role lost a privilege PUBLIC gave it,
-- nothing is kept.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $roles$
BEGIN
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'tighten table grants: roles anon, authenticated and service_role must exist';
  END IF;
END
$roles$;

CREATE TABLE IF NOT EXISTS public.table_grant_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  relation text NOT NULL,
  column_name text,
  grantee text NOT NULL CHECK (grantee IN ('anon', 'PUBLIC', 'authenticated', 'service_role')),
  privilege text NOT NULL CHECK (privilege IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')),
  change text NOT NULL CHECK (change IN ('revoked', 'granted')),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.table_grant_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.table_grant_changes FROM PUBLIC, anon, authenticated, service_role;
DO $seq$
BEGIN
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',
                 pg_get_serial_sequence('public.table_grant_changes', 'id'));
END
$seq$;

COMMENT ON TABLE public.table_grant_changes IS
  'Grants removed from anon and PUBLIC, and grants added to authenticated and service_role, by 20261119090900_tighten_table_grants. Read by its rollback. Owner only.';

-- The one rule for which relations are reachable without a sign-in test. It
-- reads the catalogue only. A policy carries no sign-in test when its text is
-- empty or true, or names none of the auth, role, staff, jwt, participant or
-- company-membership tests below.
CREATE OR REPLACE FUNCTION public.table_grant_open_relations()
RETURNS TABLE (relation_oid oid, relation text, basis text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
  WITH anon_role AS (
    SELECT oid AS anon_oid FROM pg_roles WHERE rolname = 'anon'
  ),
  rel AS (
    SELECT c.oid,
           format('%I.%I', n.nspname, c.relname) AS relation,
           c.relkind,
           c.relrowsecurity AS rls_on,
           coalesce(c.reloptions && ARRAY['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false) AS view_invoker,
           has_any_column_privilege('anon', c.oid, 'SELECT') AS anon_select,
           (has_any_column_privilege('anon', c.oid, 'INSERT')
             OR has_any_column_privilege('anon', c.oid, 'UPDATE')
             OR has_table_privilege('anon', c.oid, 'DELETE')) AS anon_write
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ),
  pol AS (
    SELECT p.polrelid,
           p.polcmd,
           regexp_replace(regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), '\s+', ' ', 'g'),
                          'auth\.role\(\)', 'AUTHROLE', 'g') AS using_t,
           regexp_replace(regexp_replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g'),
                          'auth\.role\(\)', 'AUTHROLE', 'g') AS check_t
    FROM pg_policy p
    CROSS JOIN anon_role a
    WHERE p.polpermissive
      AND (0::oid = ANY (p.polroles) OR a.anon_oid = ANY (p.polroles))
  ),
  sides AS (
    SELECT pol.polrelid, s.side, s.t
    FROM pol
    CROSS JOIN LATERAL (VALUES
      ('read', pol.using_t),
      ('write', CASE pol.polcmd WHEN 'a' THEN pol.check_t
                                ELSE coalesce(nullif(pol.using_t, ''), pol.check_t) END)
    ) AS s(side, t)
    WHERE (s.side = 'read' AND pol.polcmd IN ('r', '*'))
       OR (s.side = 'write' AND pol.polcmd IN ('a', 'w', 'd', '*'))
  ),
  untested AS (
    SELECT DISTINCT polrelid, side
    FROM sides
    WHERE btrim(t) = ''
       OR t ~* '^[\s(]*true[\s)]*$'
       OR (t !~* '(auth_role\(|caller_is_staff|staff_reader|is_staff|is_admin|has_role|user_role|\.role\M|jwt\()'
           AND t !~* '(auth_org_id\(|select\s+(\w+\.)?org_id\s+from\s+(public\.)?users)'
           AND t !~* '(auth\.|auth_|AUTHROLE|staff|role|current_user|session_user|jwt|participant)')
  )
  SELECT rel.oid, rel.relation,
         CASE
           WHEN rel.relkind IN ('v', 'm', 'f') THEN 'owner rights'
           WHEN NOT rel.rls_on THEN 'row security off'
           ELSE 'policy without a sign-in test'
         END
  FROM rel
  WHERE CASE
          WHEN rel.relkind IN ('v', 'm', 'f') AND NOT rel.view_invoker
            THEN rel.anon_select OR rel.anon_write
          WHEN rel.relkind IN ('v', 'm', 'f')
            THEN false
          WHEN NOT rel.rls_on
            THEN rel.anon_select OR rel.anon_write
          ELSE (rel.anon_select AND EXISTS (SELECT 1 FROM untested u WHERE u.polrelid = rel.oid AND u.side = 'read'))
            OR (rel.anon_write AND EXISTS (SELECT 1 FROM untested u WHERE u.polrelid = rel.oid AND u.side = 'write'))
        END
  ORDER BY rel.relation COLLATE "C";
$fn$;

REVOKE ALL ON FUNCTION public.table_grant_open_relations() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.table_grant_open_relations() IS
  'Relations in schema public that anon or PUBLIC can reach without a sign-in test (20261119090900_tighten_table_grants). Reads the catalogue only. Owner only.';

DO $tighten$
DECLARE
  r record;
  g record;
  v_role text;
  v_anon oid := to_regrole('anon');
  v_left text;
BEGIN
  FOR r IN SELECT o.relation_oid, o.relation FROM public.table_grant_open_relations() o LOOP
    -- Table-level grants held directly by anon or PUBLIC.
    FOR g IN
      SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE 'anon' END AS grantee, a.privilege_type
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = r.relation_oid
        AND a.grantee IN (0, v_anon)
      ORDER BY 1, 2
    LOOP
      IF g.grantee = 'PUBLIC' AND g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE') THEN
        FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
          IF NOT EXISTS (
            SELECT 1
            FROM pg_class c
            CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
            WHERE c.oid = r.relation_oid
              AND a.grantee = to_regrole(v_role)
              AND a.privilege_type = g.privilege_type
          ) THEN
            EXECUTE format('GRANT %s ON TABLE %s TO %I', g.privilege_type, r.relation, v_role);
            INSERT INTO public.table_grant_changes (relation, grantee, privilege, change)
            VALUES (r.relation, v_role, g.privilege_type, 'granted');
          END IF;
        END LOOP;
      END IF;
      INSERT INTO public.table_grant_changes (relation, grantee, privilege, change)
      VALUES (r.relation, g.grantee, g.privilege_type, 'revoked');
    END LOOP;

    -- Column-level grants held directly by anon or PUBLIC. A table-level revoke
    -- removes them too, so they are recorded (and given to the signed-in and
    -- server roles where PUBLIC held them) before it runs.
    FOR g IN
      SELECT DISTINCT at.attname::text AS column_name,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE 'anon' END AS grantee,
             a.privilege_type
      FROM pg_attribute at
      CROSS JOIN LATERAL aclexplode(at.attacl) a
      WHERE at.attrelid = r.relation_oid
        AND at.attnum > 0
        AND NOT at.attisdropped
        AND at.attacl IS NOT NULL
        AND a.grantee IN (0, v_anon)
      ORDER BY 1, 2, 3
    LOOP
      IF g.grantee = 'PUBLIC' AND g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE') THEN
        FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
          IF NOT EXISTS (
               SELECT 1
               FROM pg_class c
               CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
               WHERE c.oid = r.relation_oid AND a.grantee = to_regrole(v_role) AND a.privilege_type = g.privilege_type)
             AND NOT EXISTS (
               SELECT 1
               FROM pg_attribute at
               CROSS JOIN LATERAL aclexplode(at.attacl) a
               WHERE at.attrelid = r.relation_oid AND at.attname = g.column_name AND at.attacl IS NOT NULL
                 AND a.grantee = to_regrole(v_role) AND a.privilege_type = g.privilege_type)
          THEN
            EXECUTE format('GRANT %s (%I) ON TABLE %s TO %I', g.privilege_type, g.column_name, r.relation, v_role);
            INSERT INTO public.table_grant_changes (relation, column_name, grantee, privilege, change)
            VALUES (r.relation, g.column_name, v_role, g.privilege_type, 'granted');
          END IF;
        END LOOP;
      END IF;
      INSERT INTO public.table_grant_changes (relation, column_name, grantee, privilege, change)
      VALUES (r.relation, g.column_name, g.grantee, g.privilege_type, 'revoked');
      EXECUTE format('REVOKE %s (%I) ON TABLE %s FROM %s', g.privilege_type, g.column_name, r.relation,
                     CASE g.grantee WHEN 'PUBLIC' THEN 'PUBLIC' ELSE 'anon' END);
    END LOOP;

    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon', r.relation);
  END LOOP;

  -- Fail closed: nothing may still be reachable.
  SELECT string_agg(o.relation, ', ' ORDER BY o.relation COLLATE "C") INTO v_left
  FROM public.table_grant_open_relations() o;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'tighten table grants: still reachable after revoke: %', v_left;
  END IF;

  -- Fail closed: no picked relation keeps any grant to anon or PUBLIC.
  SELECT string_agg(DISTINCT c.relation, ', ') INTO v_left
  FROM public.table_grant_changes c
  WHERE c.change = 'revoked'
    AND to_regclass(c.relation) IS NOT NULL
    AND (EXISTS (SELECT 1 FROM pg_class k
                 CROSS JOIN LATERAL aclexplode(coalesce(k.relacl, acldefault('r', k.relowner))) a
                 WHERE k.oid = to_regclass(c.relation) AND a.grantee IN (0, v_anon))
         OR EXISTS (SELECT 1 FROM pg_attribute at
                    CROSS JOIN LATERAL aclexplode(at.attacl) a
                    WHERE at.attrelid = to_regclass(c.relation) AND at.attacl IS NOT NULL
                      AND a.grantee IN (0, v_anon)));
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'tighten table grants: a grant to anon or PUBLIC remains on: %', v_left;
  END IF;

  -- Fail closed: every SELECT, INSERT, UPDATE and DELETE PUBLIC gave the
  -- signed-in and server roles is still theirs.
  SELECT string_agg(DISTINCT format('%s %s %s', c.relation, v.role_name, c.privilege), ', ') INTO v_left
  FROM public.table_grant_changes c
  CROSS JOIN (VALUES ('authenticated'), ('service_role')) AS v(role_name)
  WHERE c.change = 'revoked'
    AND c.grantee = 'PUBLIC'
    AND c.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    AND to_regclass(c.relation) IS NOT NULL
    AND NOT CASE WHEN c.column_name IS NULL
                 THEN has_table_privilege(v.role_name, to_regclass(c.relation), c.privilege)
                 ELSE has_column_privilege(v.role_name, to_regclass(c.relation), c.column_name, c.privilege) END;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'tighten table grants: a signed-in or server role lost a privilege: %', v_left;
  END IF;
END
$tighten$;
