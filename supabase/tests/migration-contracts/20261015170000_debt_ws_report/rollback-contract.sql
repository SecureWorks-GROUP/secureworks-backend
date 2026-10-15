-- The runner has just run the down migration against the forward stack.
-- 1. The report table, both functions and the three settings are gone; the rest of the
--    Debt Workshop settings row is untouched.
DO $$
BEGIN
  IF to_regclass('public.debt_ws_reports') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: debt_ws_reports is still there';
  END IF;
  IF to_regprocedure('public.trigger_debt_ws_report_auto()') IS NOT NULL
     OR to_regprocedure('public.debt_ws_payments_between(uuid, date, date)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a debt report function is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'debt_ws_settings'
                AND column_name IN ('report_recipients', 'report_cc', 'report_auto_send')) THEN
    RAISE EXCEPTION 'rollback contract: a report setting is still on debt_ws_settings';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.debt_ws_settings WHERE id = 1) THEN
    RAISE EXCEPTION 'rollback contract: the rollback removed the workshop settings row';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261015170000_debt_ws_report_down.sql

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261015170000_debt_ws_report.sql
DO $$
BEGIN
  IF to_regclass('public.debt_ws_reports') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
