-- After the down migration the group tables, the share pointer and the
-- client-link flag are gone. Job work orders are untouched.
DO $$
BEGIN
  IF to_regclass('public.group_work_orders') IS NOT NULL
     OR to_regclass('public.group_work_order_participants') IS NOT NULL
     OR to_regclass('public.group_work_order_signatures') IS NOT NULL
     OR to_regclass('public.group_work_order_time_entries') IS NOT NULL
     OR to_regclass('public.group_work_order_feedback') IS NOT NULL
     OR to_regclass('public.group_work_order_shares') IS NOT NULL
     OR to_regclass('public.group_work_order_settings') IS NOT NULL
     OR to_regprocedure('public.group_work_order_caller_is_staff()') IS NOT NULL
     OR to_regprocedure('public.group_work_order_caller_is_participant(uuid)') IS NOT NULL
     OR to_regprocedure('public.group_work_order_write_split(uuid, boolean)') IS NOT NULL
     OR to_regprocedure('public.freeze_group_work_order_split(uuid)') IS NOT NULL
     OR to_regprocedure('public.project_group_work_order_split(uuid)') IS NOT NULL
     OR to_regprocedure('public.unfreeze_group_work_order_split(uuid)') IS NOT NULL
     OR to_regprocedure('public.group_work_order_refuse_late_joiner()') IS NOT NULL
     OR to_regprocedure('public.group_work_order_shares_frozen_guard()') IS NOT NULL
     OR to_regprocedure('public.trade_invoice_lines_group_share_snapshot()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: group work order tables and functions must be removed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_trade_invoice_lines_group_share_snapshot'
  ) THEN
    RAISE EXCEPTION 'rollback: the share snapshot trigger must be removed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trade_invoice_lines'
      AND column_name = 'group_share_id'
  ) THEN
    RAISE EXCEPTION 'rollback: trade_invoice_lines.group_share_id must be removed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'group_work_order_client_link_send_v1'
  ) THEN
    RAISE EXCEPTION 'rollback: the client-link flag must be removed';
  END IF;
END $$;
