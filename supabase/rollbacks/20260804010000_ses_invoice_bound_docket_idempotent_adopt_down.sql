-- Rollback restores the pre-adopt obligation-only idempotency key body from
-- 20260803010000. Prefer re-applying that migration's function definition.
-- Not inlined here to avoid drift; ops re-run:
--   supabase/migrations/20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql
-- function commit_ses_invoice_bound_docket_v1 only.
SELECT 1;
