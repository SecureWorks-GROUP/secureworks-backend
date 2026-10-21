-- Reverse 20261021140000_group_work_orders.sql. Drops the group tables
-- and the invoice pointer. Does not touch work orders, jobs or invoices
-- other than trade_invoice_lines.group_share_id.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
