-- After 20261115092000's rollback: the due list is back on its fixed search_path alone, and the
-- body, comment and access are untouched.
\set ON_ERROR_STOP on
DO $down$
DECLARE sig constant text := 'public.context_ledger_due(integer)'; p record;
BEGIN
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(sig);
 IF p IS NULL THEN RAISE EXCEPTION 'due time rollback contract: % is missing', sig; END IF;
 IF p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] OR NOT p.prosecdef OR p.provolatile <> 's' THEN
  RAISE EXCEPTION 'due time rollback contract: the list must be back on its search_path alone (config %)', p.proconfig;
 END IF;
 IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE')
    OR NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
  RAISE EXCEPTION 'due time rollback contract: the access changed';
 END IF;
END $down$;
