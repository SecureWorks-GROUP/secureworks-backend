-- After the rollback every table and column grant in schema public is exactly
-- what it was before the migration, and the record and rule are gone.
\set ON_ERROR_STOP on
DO $rb$
DECLARE
  v_diff text;
BEGIN
  WITH now_grants AS (
    SELECT c.relname::text AS relation, NULL::text AS column_name,
           a.grantee::regrole::text AS grantee, a.privilege_type, a.is_grantable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    UNION ALL
    SELECT c.relname::text, at.attname::text,
           a.grantee::regrole::text, a.privilege_type, a.is_grantable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute at ON at.attrelid = c.oid AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL
    CROSS JOIN LATERAL aclexplode(at.attacl) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ),
  diff AS (
    (SELECT 'missing' AS side, * FROM ztg_before.grants EXCEPT SELECT 'missing', * FROM now_grants)
    UNION ALL
    (SELECT 'extra', * FROM now_grants EXCEPT SELECT 'extra', * FROM ztg_before.grants)
  )
  SELECT string_agg(format('%s %s.%s %s %s', side, relation, coalesce(column_name, '*'), grantee, privilege_type), '; ')
  INTO v_diff FROM diff;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: grants differ from before the migration: %', v_diff;
  END IF;
  IF to_regclass('public.table_grant_changes') IS NOT NULL
     OR to_regprocedure('public.table_grant_open_relations()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: the record or the rule is still there';
  END IF;
  IF NOT has_table_privilege('anon', 'public.ztg_rls_off', 'SELECT')
     OR NOT has_table_privilege('anon', 'public.ztg_public_only', 'INSERT')
     OR NOT has_column_privilege('anon', 'public.ztg_column_grant', 'shown', 'SELECT') THEN
    RAISE EXCEPTION 'rollback contract: a removed grant was not restored';
  END IF;
END
$rb$;
