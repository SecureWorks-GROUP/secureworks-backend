-- Rollback for 20261029170100_context_job_bill_outcomes: drop the Context read.
-- It owns no table and no row; CFO's view is untouched.
DROP FUNCTION IF EXISTS public.context_job_bill_outcomes(uuid);
