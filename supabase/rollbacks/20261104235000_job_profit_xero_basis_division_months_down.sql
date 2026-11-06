-- Rollback of 20261104235000_job_profit_xero_basis_division_months: drops the three objects it added. There is no
-- earlier definition to restore (the migration changes no existing object). Re-running it is a no-op.
DROP VIEW IF EXISTS public.v_job_profit_division_months;
DROP VIEW IF EXISTS public.v_job_profit_xero_basis_lines;
DROP FUNCTION IF EXISTS public.job_profit_job_division(text, text);
