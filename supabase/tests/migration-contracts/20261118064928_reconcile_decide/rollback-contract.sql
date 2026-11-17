BEGIN;
DO $rollback$ /* block */ BEGIN
 IF to_regprocedure('public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)') IS NOT NULL
 OR to_regprocedure('public.reconcile_decide_live_job(uuid,uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'P2-03.3 rollback must remove reconcile_decide'; END IF;
 IF to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL
 OR to_regclass('public.reconcile_decisions') IS NULL THEN
  RAISE EXCEPTION 'P2-03.3 rollback must keep the raise, the list and the log'; END IF;
END $rollback$;
SELECT 'PASS P2-03.3 rollback: reconcile_decide removed, raise, list and log kept';
ROLLBACK;
