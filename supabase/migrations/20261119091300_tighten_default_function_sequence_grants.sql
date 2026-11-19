-- Tighten default privileges, function execute grants and sequence grants
-- (step two: the anonymous role).
--
-- Three parts, each read from the catalogue when this runs, by
-- public.object_grant_open(), so the file names no function or sequence:
--   A. SECURITY DEFINER functions and procedures in schema public: EXECUTE is
--      removed from anon and PUBLIC (which anon inherits). SECURITY INVOKER
--      routines are left alone; they run with the caller's rights.
--   B. Sequences in schema public: every privilege is removed from anon and
--      PUBLIC.
--   C. Default privileges of role postgres: nothing postgres creates in schema
--      public from now on is granted to anon, and no function it creates is
--      executable by PUBLIC. A schema's default privileges can only add to the
--      role's global ones, and the built-in global default lets PUBLIC execute
--      every new function, so PUBLIC's EXECUTE is removed from postgres's
--      global function defaults; the other removals are made in schema public.
--      Default privileges of other creating roles are not changed here.
--
-- Where PUBLIC held a privilege, authenticated and service_role first receive
-- it as their own when they do not already hold it, so no signed-in caller and
-- no server caller loses anything: on a function, EXECUTE; on a sequence,
-- USAGE, SELECT and UPDATE (so an insert into a table whose serial column uses
-- the sequence keeps working); in the defaults for new functions in schema
-- public, EXECUTE. authenticated's and service_role's own default privileges
-- are otherwise unchanged.
--
-- Every grant removed or added is recorded in public.object_grant_changes,
-- which supabase/rollbacks/20261119091300_tighten_default_function_sequence_grants_down.sql
-- reads to restore exactly what was held. A second apply finds nothing to
-- change and records nothing. The migration fails closed: if anon or PUBLIC
-- still holds any of these after the revokes (a grant this role cannot
-- remove), or authenticated or service_role lost a privilege, nothing is kept.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $roles$
BEGIN
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL
     OR to_regrole('service_role') IS NULL OR to_regrole('postgres') IS NULL THEN
    RAISE EXCEPTION 'tighten default, function and sequence grants: roles anon, authenticated, service_role and postgres must exist';
  END IF;
END
$roles$;

CREATE TABLE IF NOT EXISTS public.object_grant_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_kind text NOT NULL CHECK (object_kind IN ('function', 'sequence', 'default')),
  -- A function's signature or a sequence's name, schema-qualified; for a
  -- default privilege, the schema ('public') or '*' for the role's global one.
  object text NOT NULL,
  -- For a default privilege only: TABLES, SEQUENCES or FUNCTIONS.
  object_type text CHECK (object_type IN ('TABLES', 'SEQUENCES', 'FUNCTIONS')),
  grantee text NOT NULL CHECK (grantee IN ('anon', 'PUBLIC', 'authenticated', 'service_role')),
  privilege text NOT NULL CHECK (privilege IN ('EXECUTE', 'USAGE', 'SELECT', 'UPDATE', 'INSERT', 'DELETE',
                                               'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')),
  grantable boolean NOT NULL DEFAULT false,
  change text NOT NULL CHECK (change IN ('revoked', 'granted')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((object_kind = 'default') = (object_type IS NOT NULL))
);
ALTER TABLE public.object_grant_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.object_grant_changes FROM PUBLIC, anon, authenticated, service_role;
DO $seq$
BEGIN
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',
                 pg_get_serial_sequence('public.object_grant_changes', 'id'));
END
$seq$;

COMMENT ON TABLE public.object_grant_changes IS
  'Grants removed from anon and PUBLIC, and grants added to authenticated and service_role, by 20261119091300_tighten_default_function_sequence_grants. Read by its rollback. Owner only.';

-- The one rule for which grants step two removes. It reads the catalogue
-- only. One row per grant held by anon or PUBLIC on: a SECURITY DEFINER
-- routine in schema public; a sequence in schema public; postgres's default
-- privileges for new tables, sequences and functions in schema public (its
-- schema entry, and its global entry, which applies in every schema).
CREATE OR REPLACE FUNCTION public.object_grant_open()
RETURNS TABLE (object_kind text, object_oid oid, object text, object_type text,
               grantee text, privilege text, grantable boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
  WITH r AS (
    SELECT (SELECT oid FROM pg_roles WHERE rolname = 'anon') AS anon_oid,
           (SELECT oid FROM pg_roles WHERE rolname = 'postgres') AS postgres_oid
  ),
  kinds AS (
    SELECT * FROM (VALUES ('r'::"char", 'TABLES'), ('S'::"char", 'SEQUENCES'), ('f'::"char", 'FUNCTIONS'))
      AS k(objtype, object_type)
  )
  SELECT 'function', p.oid, p.oid::regprocedure::text, NULL::text,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE 'anon' END, a.privilege_type, a.is_grantable
  FROM pg_proc p
  CROSS JOIN r
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosecdef
    AND p.prokind IN ('f', 'p')
    AND a.grantee IN (0, r.anon_oid)
  UNION ALL
  SELECT 'sequence', c.oid, c.oid::regclass::text, NULL::text,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE 'anon' END, a.privilege_type, a.is_grantable
  FROM pg_class c
  CROSS JOIN r
  CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relkind = 'S'
    AND a.grantee IN (0, r.anon_oid)
  UNION ALL
  SELECT 'default', NULL::oid, 'public', k.object_type,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE 'anon' END, a.privilege_type, a.is_grantable
  FROM pg_default_acl d
  CROSS JOIN r
  JOIN kinds k ON k.objtype = d.defaclobjtype
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole = r.postgres_oid
    AND d.defaclnamespace = 'public'::regnamespace
    AND a.grantee IN (0, r.anon_oid)
  UNION ALL
  SELECT 'default', NULL::oid, '*', k.object_type,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE 'anon' END, a.privilege_type, a.is_grantable
  FROM kinds k
  CROSS JOIN r
  CROSS JOIN LATERAL aclexplode(coalesce(
    (SELECT d.defaclacl FROM pg_default_acl d
      WHERE d.defaclrole = r.postgres_oid AND d.defaclnamespace = 0 AND d.defaclobjtype = k.objtype),
    acldefault(k.objtype, r.postgres_oid))) a
  WHERE r.postgres_oid IS NOT NULL
    AND a.grantee IN (0, r.anon_oid);
$fn$;

REVOKE ALL ON FUNCTION public.object_grant_open() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.object_grant_open() IS
  'Grants to anon and PUBLIC on SECURITY DEFINER routines and sequences in schema public, and in postgres''s default privileges for new objects in schema public (20261119091300_tighten_default_function_sequence_grants). Reads the catalogue only. Owner only.';

DO $tighten$
DECLARE
  g record;
  v_role text;
  v_anon oid := to_regrole('anon');
  v_postgres oid := to_regrole('postgres');
  v_target text;
  v_left text;
BEGIN
  -- Recorded names are fully schema-qualified, whatever the caller's path.
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);

  -- What authenticated and service_role can do before, on every routine and
  -- sequence about to change, and in postgres's effective defaults for new
  -- objects in schema public. Compared after the revokes.
  CREATE TEMP TABLE object_grant_before ON COMMIT DROP AS
  SELECT DISTINCT o.object_kind, o.object_oid, v.role_name, pr.privilege
  FROM public.object_grant_open() o
  CROSS JOIN (VALUES ('authenticated'), ('service_role')) AS v(role_name)
  CROSS JOIN LATERAL (VALUES ('EXECUTE'), ('USAGE'), ('SELECT'), ('UPDATE')) AS pr(privilege)
  WHERE o.object_kind IN ('function', 'sequence')
    AND CASE
          WHEN o.object_kind = 'function' THEN pr.privilege = 'EXECUTE'
            AND has_function_privilege(v.role_name, o.object_oid, 'EXECUTE')
          ELSE pr.privilege <> 'EXECUTE'
            AND has_sequence_privilege(v.role_name, o.object_oid, pr.privilege)
        END;

  CREATE TEMP TABLE object_grant_defaults_before ON COMMIT DROP AS
  SELECT DISTINCT k.object_type, v.role_name, a.privilege_type AS privilege
  FROM (VALUES ('r'::"char", 'TABLES'), ('S'::"char", 'SEQUENCES'), ('f'::"char", 'FUNCTIONS')) AS k(objtype, object_type)
  CROSS JOIN LATERAL aclexplode(
    coalesce((SELECT d.defaclacl FROM pg_default_acl d
               WHERE d.defaclrole = v_postgres AND d.defaclnamespace = 0 AND d.defaclobjtype = k.objtype),
             acldefault(k.objtype, v_postgres))
    || coalesce((SELECT d.defaclacl FROM pg_default_acl d
                  WHERE d.defaclrole = v_postgres AND d.defaclnamespace = 'public'::regnamespace
                    AND d.defaclobjtype = k.objtype),
                '{}'::aclitem[])) a
  CROSS JOIN (VALUES ('authenticated'), ('service_role')) AS v(role_name)
  WHERE a.grantee IN (0, to_regrole(v.role_name));

  -- A. Routines.
  FOR g IN
    SELECT DISTINCT o.object_oid, o.object
    FROM public.object_grant_open() o
    WHERE o.object_kind = 'function'
    ORDER BY o.object
  LOOP
    IF EXISTS (SELECT 1 FROM public.object_grant_open() o
               WHERE o.object_kind = 'function' AND o.object_oid = g.object_oid AND o.grantee = 'PUBLIC') THEN
      FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
        IF NOT EXISTS (
          SELECT 1 FROM pg_proc p
          CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.oid = g.object_oid AND a.grantee = to_regrole(v_role) AND a.privilege_type = 'EXECUTE'
        ) THEN
          EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO %I', g.object, v_role);
          INSERT INTO public.object_grant_changes (object_kind, object, grantee, privilege, change)
          VALUES ('function', g.object, v_role, 'EXECUTE', 'granted');
        END IF;
      END LOOP;
    END IF;
    INSERT INTO public.object_grant_changes (object_kind, object, grantee, privilege, grantable, change)
    SELECT 'function', o.object, o.grantee, o.privilege, o.grantable, 'revoked'
    FROM public.object_grant_open() o
    WHERE o.object_kind = 'function' AND o.object_oid = g.object_oid
    ORDER BY o.grantee, o.privilege;
    EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC, anon', g.object);
  END LOOP;

  -- B. Sequences.
  FOR g IN
    SELECT DISTINCT o.object_oid, o.object
    FROM public.object_grant_open() o
    WHERE o.object_kind = 'sequence'
    ORDER BY o.object
  LOOP
    FOR v_target IN
      SELECT DISTINCT o.privilege FROM public.object_grant_open() o
      WHERE o.object_kind = 'sequence' AND o.object_oid = g.object_oid AND o.grantee = 'PUBLIC'
        AND o.privilege IN ('USAGE', 'SELECT', 'UPDATE')
      ORDER BY 1
    LOOP
      FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c
          CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
          WHERE c.oid = g.object_oid AND a.grantee = to_regrole(v_role) AND a.privilege_type = v_target
        ) THEN
          EXECUTE format('GRANT %s ON SEQUENCE %s TO %I', v_target, g.object, v_role);
          INSERT INTO public.object_grant_changes (object_kind, object, grantee, privilege, change)
          VALUES ('sequence', g.object, v_role, v_target, 'granted');
        END IF;
      END LOOP;
    END LOOP;
    INSERT INTO public.object_grant_changes (object_kind, object, grantee, privilege, grantable, change)
    SELECT 'sequence', o.object, o.grantee, o.privilege, o.grantable, 'revoked'
    FROM public.object_grant_open() o
    WHERE o.object_kind = 'sequence' AND o.object_oid = g.object_oid
    ORDER BY o.grantee, o.privilege;
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon', g.object);
  END LOOP;

  -- C. Default privileges for what postgres creates from now on. Whatever
  -- PUBLIC would have been given on a new object in schema public,
  -- authenticated and service_role keep as their own default there.
  FOR g IN
    SELECT DISTINCT o.object_type, o.privilege
    FROM public.object_grant_open() o
    WHERE o.object_kind = 'default' AND o.grantee = 'PUBLIC'
    ORDER BY 1, 2
  LOOP
    FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_default_acl d
        CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclrole = v_postgres AND d.defaclnamespace IN (0, 'public'::regnamespace)
          AND d.defaclobjtype = CASE g.object_type WHEN 'TABLES' THEN 'r' WHEN 'SEQUENCES' THEN 'S' ELSE 'f' END::"char"
          AND a.grantee = to_regrole(v_role) AND a.privilege_type = g.privilege
      ) THEN
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT %s ON %s TO %I',
                       g.privilege, g.object_type, v_role);
        INSERT INTO public.object_grant_changes (object_kind, object, object_type, grantee, privilege, change)
        VALUES ('default', 'public', g.object_type, v_role, g.privilege, 'granted');
      END IF;
    END LOOP;
  END LOOP;

  FOR g IN
    SELECT o.object, o.object_type, o.grantee, o.privilege, o.grantable
    FROM public.object_grant_open() o
    WHERE o.object_kind = 'default'
    ORDER BY o.object, o.object_type, o.grantee, o.privilege
  LOOP
    INSERT INTO public.object_grant_changes (object_kind, object, object_type, grantee, privilege, grantable, change)
    VALUES ('default', g.object, g.object_type, g.grantee, g.privilege, g.grantable, 'revoked');
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres %s REVOKE %s ON %s FROM %s',
                   CASE g.object WHEN '*' THEN '' ELSE 'IN SCHEMA public' END,
                   g.privilege, g.object_type,
                   CASE g.grantee WHEN 'PUBLIC' THEN 'PUBLIC' ELSE 'anon' END);
  END LOOP;

  -- Fail closed: nothing is left to anon or PUBLIC.
  SELECT string_agg(DISTINCT coalesce(o.object_type || ' in ', '') || o.object, ', ') INTO v_left
  FROM public.object_grant_open() o;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'tighten default, function and sequence grants: still granted to anon or PUBLIC after revoke: %', v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM public.object_grant_changes c
             WHERE c.change = 'revoked' AND c.object_kind = 'function'
               AND to_regprocedure(c.object) IS NOT NULL
               AND has_function_privilege('anon', to_regprocedure(c.object), 'EXECUTE'))
     OR EXISTS (SELECT 1 FROM public.object_grant_changes c
                WHERE c.change = 'revoked' AND c.object_kind = 'sequence'
                  AND to_regclass(c.object) IS NOT NULL
                  AND (has_sequence_privilege('anon', to_regclass(c.object), 'USAGE')
                       OR has_sequence_privilege('anon', to_regclass(c.object), 'SELECT')
                       OR has_sequence_privilege('anon', to_regclass(c.object), 'UPDATE'))) THEN
    RAISE EXCEPTION 'tighten default, function and sequence grants: anon still reaches a changed routine or sequence';
  END IF;

  -- Fail closed: authenticated and service_role can do everything they could.
  SELECT string_agg(format('%s %s %s', b.object_kind, b.role_name, b.privilege), ', ') INTO v_left
  FROM object_grant_before b
  WHERE NOT CASE WHEN b.object_kind = 'function'
                 THEN has_function_privilege(b.role_name, b.object_oid, b.privilege)
                 ELSE has_sequence_privilege(b.role_name, b.object_oid, b.privilege) END;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'tighten default, function and sequence grants: a signed-in or server role lost a privilege: %', v_left;
  END IF;

  -- Fail closed: in schema public, new objects still give authenticated and
  -- service_role what they gave before, including EXECUTE PUBLIC gave them.
  SELECT string_agg(format('%s %s %s', b.object_type, b.role_name, b.privilege), ', ') INTO v_left
  FROM object_grant_defaults_before b
  WHERE NOT EXISTS (
    SELECT 1
    FROM (VALUES ('r'::"char", 'TABLES'), ('S'::"char", 'SEQUENCES'), ('f'::"char", 'FUNCTIONS')) AS k(objtype, object_type)
    CROSS JOIN LATERAL aclexplode(
      coalesce((SELECT d.defaclacl FROM pg_default_acl d
                 WHERE d.defaclrole = v_postgres AND d.defaclnamespace = 0 AND d.defaclobjtype = k.objtype),
               acldefault(k.objtype, v_postgres))
      || coalesce((SELECT d.defaclacl FROM pg_default_acl d
                    WHERE d.defaclrole = v_postgres AND d.defaclnamespace = 'public'::regnamespace
                      AND d.defaclobjtype = k.objtype),
                  '{}'::aclitem[])) a
    WHERE k.object_type = b.object_type AND a.grantee = to_regrole(b.role_name) AND a.privilege_type = b.privilege
  );
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'tighten default, function and sequence grants: a signed-in or server role lost a default privilege: %', v_left;
  END IF;

  DROP TABLE object_grant_before;
  DROP TABLE object_grant_defaults_before;
END
$tighten$;
