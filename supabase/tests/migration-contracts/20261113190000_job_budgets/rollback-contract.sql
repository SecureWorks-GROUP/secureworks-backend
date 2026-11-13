-- The runner has just run the down migration against the forward stack.
-- 1. The writer, the read and the guard are gone; both tables are kept.
DO $$
BEGIN
  IF to_regprocedure('public.record_job_budget(uuid, uuid, text, text[], jsonb, jsonb, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: the budget writer is still there';
  END IF;
  IF to_regclass('public.v_job_budget') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: the budget read is still there';
  END IF;
  IF to_regprocedure('public.job_budgets_write_once()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: the write-once function is still there';
  END IF;
  IF to_regclass('public.job_budgets') IS NULL OR to_regclass('public.job_budget_lines') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: a budget table was dropped';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261113190000_job_budgets_down.sql

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261113190000_job_budgets.sql
DO $$
BEGIN
  IF to_regprocedure('public.record_job_budget(uuid, uuid, text, text[], jsonb, jsonb, jsonb)') IS NULL
     OR to_regclass('public.v_job_budget') IS NULL
     OR to_regprocedure('public.job_budgets_write_once()') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
