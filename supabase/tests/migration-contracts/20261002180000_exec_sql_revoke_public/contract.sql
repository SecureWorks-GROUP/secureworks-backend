-- exec_sql is closed to the public key: anon and authenticated are refused,
-- service_role still runs it as the owner, and the function is not dropped.
DO $$
DECLARE
  v_fn regprocedure := to_regprocedure('public.exec_sql(text)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'exec_sql contract: function was dropped';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'exec_sql contract: function is no longer SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'exec_sql contract: anon can still execute';
  END IF;
  IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'exec_sql contract: authenticated can still execute';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
             WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'exec_sql contract: PUBLIC still holds execute';
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'exec_sql contract: service_role lost execute';
  END IF;
END $$;

-- anon: a real call is refused with permission denied.
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM public.exec_sql('SELECT v FROM public.exec_sql_contract_secret');
  RAISE EXCEPTION 'exec_sql contract: anon call was not refused';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
ROLLBACK;

-- authenticated: a real call is refused with permission denied.
BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.exec_sql('SELECT v FROM public.exec_sql_contract_secret');
  RAISE EXCEPTION 'exec_sql contract: authenticated call was not refused';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
ROLLBACK;

-- service_role: still runs as the owner and reads an owner-only table.
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE r jsonb;
BEGIN
  r := public.exec_sql('SELECT v FROM public.exec_sql_contract_secret WHERE id = 1');
  IF r IS DISTINCT FROM '[{"v": "owner-only"}]'::jsonb THEN
    RAISE EXCEPTION 'exec_sql contract: service_role call returned %', r;
  END IF;
END $$;
ROLLBACK;
