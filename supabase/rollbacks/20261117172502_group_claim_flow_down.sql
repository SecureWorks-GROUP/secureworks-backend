-- Preserve recorded answers; an empty dormant schema can be removed.
DO $rollback$ BEGIN
  IF EXISTS (SELECT 1 FROM public.group_work_order_approvals) THEN
    RAISE EXCEPTION 'group_claim_approvals_exist';
  END IF;
END; $rollback$;
DROP FUNCTION public.group_claim_split_hash(uuid);

ALTER TABLE public.group_work_order_events DROP CONSTRAINT group_work_order_events_action_check;
ALTER TABLE public.group_work_order_events ADD CONSTRAINT group_work_order_events_action_check
  CHECK (action IN ('freeze','unfreeze','revoke_signoff','void_group','rekey','remove_participant',
    'approve_budget','amend_pay_basis','release','office_issue_invoices','office_approve_hours','restore_participant'));
ALTER TABLE public.group_work_order_time_entries
  DROP COLUMN changed_from_suggestion, DROP COLUMN suggested;
DROP TRIGGER group_claim_approvals_append_only ON public.group_work_order_approvals;
DROP FUNCTION public.group_claim_approvals_append_only();
DROP TABLE public.group_work_order_approvals;
ALTER TABLE public.group_work_order_participants DROP COLUMN named_at, DROP COLUMN named_by;
DROP INDEX public.group_work_orders_claim_due_idx;
ALTER TABLE public.group_work_orders
  DROP COLUMN claim_deadline_at, DROP COLUMN claim_started_by, DROP COLUMN claim_state;
DELETE FROM public.feature_flags WHERE flag_name IN ('group_claim_flow_v1','group_claim_all_jobs_v1');
