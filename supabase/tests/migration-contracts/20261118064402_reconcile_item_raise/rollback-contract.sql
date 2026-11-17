BEGIN;
DO $rollback$ /* block */ BEGIN
 IF to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NOT NULL
 OR to_regprocedure('public.reconcile_item_withdraw(text,text,text,text)') IS NOT NULL
 OR to_regprocedure('public.reconcile_item_org(text,text,uuid[])') IS NOT NULL THEN
  RAISE EXCEPTION 'P2-03.2 rollback must remove the three functions'; END IF;
 IF to_regclass('public.reconcile_items') IS NULL OR to_regclass('public.reconcile_decisions') IS NULL THEN
  RAISE EXCEPTION 'P2-03.2 rollback must keep P2-03.1 list and log'; END IF;
END $rollback$;
SELECT 'PASS P2-03.2 rollback: functions removed, list and log kept';
ROLLBACK;
