-- Rollback for 20261029170000_cfo_bill_cost_outcomes: drop the read-only outcome
-- view. It owns no table and no row; the engine views are untouched. Roll back
-- 20261029170100_context_job_bill_outcomes first (its function reads this view).
DROP VIEW IF EXISTS public.cfo_bill_cost_outcomes;
