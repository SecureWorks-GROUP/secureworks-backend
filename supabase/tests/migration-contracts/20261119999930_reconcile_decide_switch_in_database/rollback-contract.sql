\set ON_ERROR_STOP on
BEGIN;
DO $down$
/* block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)'::regprocedure)
      IS DISTINCT FROM '5eb8d0b43f1a2b8339d3f739a6d05433'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_undo(bigint,uuid)'::regprocedure)
      IS DISTINCT FROM '8d34d85b018204c72d7db66ea915dcda' THEN
  RAISE EXCEPTION 'rollback must return main''s reconcile_decide and reconcile_undo bodies';
 END IF;
 IF NOT has_function_privilege('service_role', 'public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)', 'execute')
  OR has_function_privilege('authenticated', 'public.reconcile_undo(bigint,uuid)', 'execute')
  OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'reconcile_decide_v1') IS NOT FALSE THEN
  RAISE EXCEPTION 'rollback must keep grants and leave the switch as it was';
 END IF;
END $down$;
SELECT 'PASS reconcile decide switch in the database rollback: main''s bodies, grants and switch kept' AS result;
ROLLBACK;
