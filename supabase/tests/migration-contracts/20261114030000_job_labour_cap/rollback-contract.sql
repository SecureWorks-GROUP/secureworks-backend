-- The runner has just run the down migration against the forward stack.
-- 1. Every step 4 object is gone and the switch row with it.
DO $$
BEGIN
  IF to_regclass('public.job_labour_cap_raises') IS NOT NULL
     OR to_regprocedure('public.job_labour_cap_state(uuid)') IS NOT NULL
     OR to_regprocedure('public.raise_job_labour_cap(uuid, uuid, uuid, text, uuid, numeric, text)') IS NOT NULL
     OR to_regprocedure('public.job_labour_cap_check_invoice(uuid)') IS NOT NULL
     OR to_regprocedure('public.job_labour_budget_on()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a labour cap object is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('job_labour_cap_guard_line', 'job_labour_cap_guard_invoice')) THEN
    RAISE EXCEPTION 'rollback contract: a labour cap guard is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_labour_budget_v1') THEN
    RAISE EXCEPTION 'rollback contract: the switch row is still there';
  END IF;
  IF to_regclass('public.job_budgets') IS NULL OR to_regclass('public.trade_invoice_lines') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: a table this migration does not own was dropped';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261114030000_job_labour_cap_down.sql

-- 3. The forward migration applies again cleanly after a rollback, seeded off.
BEGIN;
\ir ../../../migrations/20261114030000_job_labour_cap.sql
DO $$
BEGIN
  IF to_regprocedure('public.job_labour_cap_state(uuid)') IS NULL
     OR to_regclass('public.job_labour_cap_raises') IS NULL
     OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_labour_budget_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
