-- Rollback for 20261029170000_cfo_bill_cost_outcomes: drop the read-only outcome
-- view and its scoped rule. They own no table and no row; the engine views are
-- untouched. Roll back 20261029170100_context_job_bill_outcomes first (its
-- function reads the scoped rule).
DROP VIEW IF EXISTS public.cfo_bill_cost_outcomes;
DROP FUNCTION IF EXISTS public.cfo_bill_cost_outcomes_scoped(uuid);
-- The SELECT grants to service_role stay: the service role may have held them
-- before this migration (20260705000010 grants job_materials_facts), and a
-- revoke here could take away a grant this migration did not give.
