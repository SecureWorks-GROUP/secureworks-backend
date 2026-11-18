-- After the down: no page functions, no switch row; the reconcile
-- tables and their own indexes are untouched.
DO $$ BEGIN
  IF to_regprocedure('public.reconcile_list_page(uuid,text[],integer,jsonb)') IS NOT NULL
     OR to_regprocedure('public.reconcile_list_counts(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST rollback left a list function';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'reconcile_list_v1') THEN
    RAISE EXCEPTION 'ZZTEST rollback left the off switch row';
  END IF;
  IF to_regclass('public.reconcile_items_list_idx') IS NULL OR to_regclass('public.reconcile_items') IS NULL THEN
    RAISE EXCEPTION 'ZZTEST rollback touched the reconcile tables';
  END IF;
END $$;
BEGIN;
\ir ../../../migrations/20261118195200_reconcile_list_page.sql
ROLLBACK;
SELECT 'P2-03.6 reconcile list page rollback passed' AS result;
