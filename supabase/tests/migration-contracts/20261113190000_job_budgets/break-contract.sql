-- Deliberately drop the write-once trigger: the contract must fail.
DROP TRIGGER job_budgets_write_once ON public.job_budgets;
