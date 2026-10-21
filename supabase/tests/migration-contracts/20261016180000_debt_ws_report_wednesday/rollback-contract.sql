-- The runner has just run the down migration against the forward stack (no pg_cron).
-- 1. The refresh trigger is gone, the Monday words are back, and the report itself (its
--    table, its auto-send trigger and its settings) is untouched.
DO $$
BEGIN
  IF to_regprocedure('public.trigger_debt_ws_report_refresh()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: the refresh trigger is still there';
  END IF;
  IF to_regprocedure('public.trigger_debt_ws_report_auto()') IS NULL
     OR to_regclass('public.debt_ws_reports') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the rollback removed the report itself';
  END IF;
  IF obj_description('public.trigger_debt_ws_report_auto()'::regprocedure, 'pg_proc')
       NOT LIKE '%Mon 08:00 Perth%' THEN
    RAISE EXCEPTION 'rollback contract: the auto-send trigger does not name Monday again';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.debt_ws_settings WHERE id = 1 AND NOT report_auto_send) THEN
    RAISE EXCEPTION 'rollback contract: the settings row changed';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261016180000_debt_ws_report_wednesday_down.sql

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261016180000_debt_ws_report_wednesday.sql
DO $$
BEGIN
  IF to_regprocedure('public.trigger_debt_ws_report_refresh()') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
