-- Reverse 20261021141000_group_work_orders.sql. Drops the group tables
-- and the invoice pointer. Restores job_client_signoffs to the #1110
-- method list. Does not drop job_client_signoffs or client_signoff_settings.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP TRIGGER IF EXISTS trg_trade_invoice_lines_group_share_snapshot ON public.trade_invoice_lines;
DROP TRIGGER IF EXISTS trg_group_work_order_refuse_late_joiner ON public.group_work_order_participants;
DROP TRIGGER IF EXISTS trg_group_work_order_shares_frozen_guard ON public.group_work_order_shares;
DROP TRIGGER IF EXISTS trg_group_work_order_time_entries_guard ON public.group_work_order_time_entries;
DROP TRIGGER IF EXISTS trg_group_work_order_events_append_only ON public.group_work_order_events;
DROP TRIGGER IF EXISTS trg_group_work_orders_refuse_existing_pay ON public.group_work_orders;
DROP TRIGGER IF EXISTS trg_group_work_orders_void_permanent ON public.group_work_orders;

DROP FUNCTION IF EXISTS public.trade_invoice_lines_group_share_snapshot();
DROP FUNCTION IF EXISTS public.group_work_order_refuse_late_joiner();
DROP FUNCTION IF EXISTS public.group_work_order_shares_frozen_guard();
DROP FUNCTION IF EXISTS public.group_work_order_time_entries_guard();
DROP FUNCTION IF EXISTS public.group_work_order_events_append_only();
DROP FUNCTION IF EXISTS public.project_group_work_order_split(uuid);
DROP FUNCTION IF EXISTS public.freeze_group_work_order_split(uuid);
DROP FUNCTION IF EXISTS public.unfreeze_group_work_order_split(uuid, uuid);
DROP FUNCTION IF EXISTS public.unfreeze_group_work_order_split(uuid);
DROP FUNCTION IF EXISTS public.void_group_work_order(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.rekey_group_work_order(uuid, uuid);
DROP FUNCTION IF EXISTS public.revoke_group_client_signoff(uuid, uuid);
DROP FUNCTION IF EXISTS public.group_work_order_write_split(uuid, boolean);
DROP FUNCTION IF EXISTS public.group_client_signoff_counts(uuid);
DROP FUNCTION IF EXISTS public.group_work_order_assignment_covers(uuid, uuid, date);
DROP FUNCTION IF EXISTS public.remove_group_work_order_participant(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.group_work_orders_refuse_existing_pay();
DROP FUNCTION IF EXISTS public.group_work_orders_void_permanent();
DROP FUNCTION IF EXISTS public.group_work_order_line_is_normal_pay(text, uuid);
DROP FUNCTION IF EXISTS public.group_work_order_lock_job(uuid);

DROP TABLE IF EXISTS public.group_work_order_events;
DROP TABLE IF EXISTS public.group_work_order_feedback;
DROP TABLE IF EXISTS public.group_work_order_shares;
DROP TABLE IF EXISTS public.group_work_order_time_entries;
DROP TABLE IF EXISTS public.group_work_order_signatures;
DROP TABLE IF EXISTS public.group_work_order_participants;
DROP TABLE IF EXISTS public.group_work_orders;
DROP TABLE IF EXISTS public.group_work_order_settings;

-- The PNG check on group_work_order_signatures calls this function, so the
-- table has to go before the function.
DROP FUNCTION IF EXISTS public.group_work_order_signature_ok(text);

DROP FUNCTION IF EXISTS public.group_work_order_caller_is_participant(uuid);
DROP FUNCTION IF EXISTS public.group_work_order_caller_is_staff();

ALTER TABLE public.trade_invoice_lines DROP COLUMN IF EXISTS group_share_id;

ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_share_link_check;
ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_revoked_check;
ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_device_check;
ALTER TABLE public.job_client_signoffs DROP COLUMN IF EXISTS captured_device;
-- share_link and revoked exist only because this migration added them.
-- The sign-off table refuses DELETE while its append-only trigger is on, so
-- the trigger is off for this statement only. Then the #1110 check is restored.
ALTER TABLE public.job_client_signoffs DISABLE TRIGGER trg_job_client_signoffs_append_only;
DELETE FROM public.job_client_signoffs
WHERE method IN ('share_link', 'revoked');
ALTER TABLE public.job_client_signoffs ENABLE TRIGGER trg_job_client_signoffs_append_only;

ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_method_check;
ALTER TABLE public.job_client_signoffs ADD CONSTRAINT job_client_signoffs_method_check
  CHECK (method IN ('on_site', 'office_waiver'));

DELETE FROM public.feature_flags
WHERE flag_name IN (
  'group_work_order_client_link_send_v1',
  'group_work_order_v1'
);
