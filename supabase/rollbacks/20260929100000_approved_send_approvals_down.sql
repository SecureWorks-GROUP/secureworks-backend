-- Rollback for 20260929100000_approved_send_approvals.sql.
-- Drops only what that migration created. Run it only after the matching
-- edge code is rolled back, because the approved-send paths read these tables.
-- Dropping the audit discards the approved-send history: export it first
-- (select * from public.approved_send_approvals / approved_send_audit).

DROP TRIGGER IF EXISTS approved_send_audit_append_only ON public.approved_send_audit;
DROP TRIGGER IF EXISTS approved_send_approvals_insert_guard ON public.approved_send_approvals;
DROP TRIGGER IF EXISTS approved_send_approvals_guard ON public.approved_send_approvals;
DROP TABLE IF EXISTS public.approved_send_audit;
DROP TABLE IF EXISTS public.approved_send_approvals;
DROP FUNCTION IF EXISTS public.approved_send_audit_append_only();
DROP FUNCTION IF EXISTS public.approved_send_approvals_insert_guard();
DROP FUNCTION IF EXISTS public.approved_send_approvals_guard();
