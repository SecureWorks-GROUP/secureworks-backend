-- Rollback for 20261119091500_group_office_day_entry_and_behind.
-- Guarded: an office entry or a dispute is a pay record, and its audit rows
-- are append-only. If either was ever written, refuse rather than drop it.
DO $rollback$ BEGIN
  IF EXISTS (SELECT 1 FROM public.group_work_order_time_entries
      WHERE entered_by_office OR disputed_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.group_work_order_events
      WHERE action IN ('office_enter_hours', 'dispute_office_hours')) THEN
    RAISE EXCEPTION 'group_office_day_entries_exist';
  END IF;
END; $rollback$;

DROP FUNCTION IF EXISTS public.group_office_dispute_hours(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.group_office_enter_hours(uuid, uuid, uuid, jsonb, text);

DROP TRIGGER IF EXISTS trg_group_work_orders_office_dispute_hold ON public.group_work_orders;
DROP FUNCTION IF EXISTS public.group_work_orders_office_dispute_hold();
DROP FUNCTION IF EXISTS public.group_work_order_office_dispute_open(uuid);

DROP TRIGGER IF EXISTS trg_group_work_order_time_entries_office ON public.group_work_order_time_entries;
DROP FUNCTION IF EXISTS public.group_work_order_time_entries_office_guard();

ALTER TABLE public.group_work_order_events DROP CONSTRAINT group_work_order_events_action_check;
ALTER TABLE public.group_work_order_events ADD CONSTRAINT group_work_order_events_action_check
  CHECK (action IN ('freeze','unfreeze','revoke_signoff','void_group','rekey','remove_participant',
    'approve_budget','amend_pay_basis','release','office_issue_invoices','office_approve_hours',
    'restore_participant','name_crew','leave_claim','confirm_hours','approve_split','dispute_split',
    'escalate','issue_invoices','office_settle'));

DROP INDEX IF EXISTS public.idx_group_work_order_time_entries_open_dispute;
ALTER TABLE public.group_work_order_time_entries
  DROP CONSTRAINT IF EXISTS group_work_order_time_entries_dispute_check,
  DROP CONSTRAINT IF EXISTS group_work_order_time_entries_office_entry_check,
  DROP COLUMN IF EXISTS dispute_resolved_by,
  DROP COLUMN IF EXISTS dispute_resolved_at,
  DROP COLUMN IF EXISTS dispute_reason,
  DROP COLUMN IF EXISTS disputed_by,
  DROP COLUMN IF EXISTS disputed_at,
  DROP COLUMN IF EXISTS office_entry_reason,
  DROP COLUMN IF EXISTS office_entered_at,
  DROP COLUMN IF EXISTS office_entered_by,
  DROP COLUMN IF EXISTS entered_by_office;

DELETE FROM public.feature_flags WHERE flag_name = 'group_office_day_entry_v1';
