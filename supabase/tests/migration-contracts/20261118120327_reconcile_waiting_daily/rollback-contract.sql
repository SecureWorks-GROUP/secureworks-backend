BEGIN;
DO $rollback$
/* block */ BEGIN
  IF to_regclass('public.reconcile_waiting_daily') IS NOT NULL THEN
    RAISE EXCEPTION 'P2-13.8 rollback must drop reconcile_waiting_daily';
  END IF;
  IF to_regprocedure('public.reconcile_waiting_summary()') IS NOT NULL
     OR to_regprocedure('public.reconcile_waiting_snapshot(date)') IS NOT NULL
     OR to_regprocedure('public.reconcile_waiting_days(integer)') IS NOT NULL
     OR to_regprocedure('public.reconcile_waiting_daily_trim(date,integer)') IS NOT NULL
     OR to_regprocedure('public.reconcile_waiting_daily_install()') IS NOT NULL
     OR to_regprocedure('public.reconcile_waiting_daily_remove()') IS NOT NULL THEN
    RAISE EXCEPTION 'P2-13.8 rollback must drop all six functions';
  END IF;
  IF to_regclass('public.reconcile_items') IS NULL
     OR to_regclass('public.reconcile_item_kinds') IS NULL THEN
    RAISE EXCEPTION 'P2-13.8 rollback must preserve reconcile_items and reconcile_item_kinds';
  END IF;
END $rollback$;
SELECT 'PASS P2-13.8 rollback: daily table and functions removed, shared list preserved';
ROLLBACK;
