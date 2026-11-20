-- After the rollback every routine, sequence and default-privilege grant is
-- exactly what it was before the migration, and the record and rule are gone.
\set ON_ERROR_STOP on
DO $rb$
DECLARE
  v_diff text;
BEGIN
  WITH now_grants AS (
    SELECT 'routine' AS kind, p.oid::regprocedure::text AS object, NULL::text AS object_type,
           a.grantee::regrole::text AS grantee, a.privilege_type, a.is_grantable
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.pronamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'sequence', c.oid::regclass::text, NULL, a.grantee::regrole::text, a.privilege_type, a.is_grantable
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
    UNION ALL
    SELECT 'default', format('%s %s', d.defaclrole::regrole, coalesce(d.defaclnamespace::regnamespace::text, '*')),
           d.defaclobjtype::text, a.grantee::regrole::text, a.privilege_type, a.is_grantable
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  ),
  diff AS (
    (SELECT 'missing' AS side, * FROM zgs_before.grants EXCEPT SELECT 'missing', * FROM now_grants)
    UNION ALL
    (SELECT 'extra', * FROM now_grants EXCEPT SELECT 'extra', * FROM zgs_before.grants)
  )
  SELECT string_agg(format('%s %s %s %s %s %s', side, kind, object, coalesce(object_type, ''), grantee, privilege_type), '; ')
  INTO v_diff FROM diff;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: grants differ from before the migration: %', v_diff;
  END IF;
  IF to_regclass('public.object_grant_changes') IS NOT NULL
     OR to_regprocedure('public.object_grant_open()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: the record or the rule is still there';
  END IF;
  IF NOT has_function_privilege('anon', 'public.zgs_definer_open(integer)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.zgs_definer_named()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.zgs_definer_named()', 'EXECUTE')
     OR NOT has_sequence_privilege('anon', 'public.zgs_serial_id_seq', 'USAGE')
     OR has_sequence_privilege('authenticated', 'public.zgs_counter', 'USAGE') THEN
    RAISE EXCEPTION 'rollback contract: a removed grant was not restored, or an added one was kept';
  END IF;
END
$rb$;
