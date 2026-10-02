-- After the down migration exec_sql holds exactly its pre-revoke grants:
-- PUBLIC, anon and authenticated can execute again, service_role still can,
-- and the function is unchanged.
DO $$
DECLARE
  v_fn regprocedure := to_regprocedure('public.exec_sql(text)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'exec_sql rollback: function missing';
  END IF;
  IF NOT has_function_privilege('anon', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'exec_sql rollback: grants not restored';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'exec_sql rollback: PUBLIC execute not restored';
  END IF;
END $$;

BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF public.exec_sql('SELECT 1 AS x') IS DISTINCT FROM '[{"x": 1}]'::jsonb THEN
    RAISE EXCEPTION 'exec_sql rollback: anon call did not run';
  END IF;
END $$;
ROLLBACK;
