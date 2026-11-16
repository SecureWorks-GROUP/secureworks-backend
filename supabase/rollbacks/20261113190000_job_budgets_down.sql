-- Rollback for 20261113190000_job_budgets.sql. Takes away the writer, the read
-- and the write-once guard; keeps both tables and every stored budget (a budget
-- is a record of what was accepted and is never thrown away). Safe to re-run.
DROP VIEW IF EXISTS public.v_job_budget;
DROP FUNCTION IF EXISTS public.record_job_budget(uuid, uuid, text, text[], jsonb, jsonb, jsonb);
DO $$
BEGIN
  IF to_regclass('public.job_budgets') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS job_budgets_write_once ON public.job_budgets;
    DROP TRIGGER IF EXISTS job_budgets_write_once_truncate ON public.job_budgets;
  END IF;
  IF to_regclass('public.job_budget_lines') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS job_budget_lines_write_once ON public.job_budget_lines;
    DROP TRIGGER IF EXISTS job_budget_lines_write_once_truncate ON public.job_budget_lines;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.job_budgets_write_once();
