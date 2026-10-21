-- Reverse 20261021140000_group_work_orders.sql. Drops the group tables
-- and the invoice pointer. Does not touch work orders, jobs or invoices
-- other than trade_invoice_lines.group_share_id and the share-line trigger.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP TRIGGER IF EXISTS trg_trade_invoice_lines_group_share_snapshot ON public.trade_invoice_lines;
DROP TRIGGER IF EXISTS trg_group_work_order_refuse_late_joiner ON public.group_work_order_participants;
DROP TRIGGER IF EXISTS trg_group_work_order_shares_frozen_guard ON public.group_work_order_shares;

DROP FUNCTION IF EXISTS public.trade_invoice_lines_group_share_snapshot();
DROP FUNCTION IF EXISTS public.group_work_order_refuse_late_joiner();
DROP FUNCTION IF EXISTS public.group_work_order_shares_frozen_guard();
DROP FUNCTION IF EXISTS public.project_group_work_order_split(uuid);
DROP FUNCTION IF EXISTS public.freeze_group_work_order_split(uuid);
DROP FUNCTION IF EXISTS public.unfreeze_group_work_order_split(uuid);
DROP FUNCTION IF EXISTS public.group_work_order_write_split(uuid, boolean);

DROP TABLE IF EXISTS public.group_work_order_feedback;
DROP TABLE IF EXISTS public.group_work_order_shares;
DROP TABLE IF EXISTS public.group_work_order_time_entries;
DROP TABLE IF EXISTS public.group_work_order_signatures;
DROP TABLE IF EXISTS public.group_work_order_participants;
DROP TABLE IF EXISTS public.group_work_orders;
DROP TABLE IF EXISTS public.group_work_order_settings;

DROP FUNCTION IF EXISTS public.group_work_order_caller_is_participant(uuid);
DROP FUNCTION IF EXISTS public.group_work_order_caller_is_staff();

ALTER TABLE public.trade_invoice_lines DROP COLUMN IF EXISTS group_share_id;

DELETE FROM public.feature_flags
WHERE flag_name = 'group_work_order_client_link_send_v1';
