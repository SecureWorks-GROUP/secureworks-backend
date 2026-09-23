-- Rollback of 20260924213000_debt_followup_approvals. Drops the two debt
-- follow-up ledger tables and their trigger functions. Nothing else changes.
-- Redeploy the previous ops-api first: the new ops-api reads and writes these
-- tables. The ledger rows (approvals and press records) are lost; export them
-- first if they are needed as audit history.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.debt_followup_claim_live(jsonb);
DROP FUNCTION IF EXISTS public.debt_followup_create_approval(jsonb);
DROP FUNCTION IF EXISTS public.debt_followup_executions_settle_once();
DROP FUNCTION IF EXISTS public.debt_followup_approvals_insert_only();
DROP TABLE IF EXISTS public.debt_followup_executions;
DROP TABLE IF EXISTS public.debt_followup_approvals;
