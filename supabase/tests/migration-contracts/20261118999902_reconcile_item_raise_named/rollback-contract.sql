BEGIN;
DO $rollback$ /* block */ BEGIN
 IF to_regprocedure('public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'named raise rollback must drop the wrapper'; END IF;
 IF to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL
 OR to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)') IS NULL THEN
  RAISE EXCEPTION 'named raise rollback must keep both reconcile_item_raise overloads'; END IF;
END $rollback$;
SELECT 'PASS reconcile_item_raise_named rollback: wrapper dropped, overloads kept';
ROLLBACK;
