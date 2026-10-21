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
     OR to_regclass('public.group_work_order_events') IS NOT NULL
     OR to_regprocedure('public.group_work_order_caller_is_staff()') IS NOT NULL
     OR to_regprocedure('public.group_work_order_caller_is_participant(uuid)') IS NOT NULL
     OR to_regprocedure('public.group_work_order_write_split(uuid, boolean)') IS NOT NULL
     OR to_regprocedure('public.freeze_group_work_order_split(uuid)') IS NOT NULL
     OR to_regprocedure('public.project_group_work_order_split(uuid)') IS NOT NULL
     OR to_regprocedure('public.unfreeze_group_work_order_split(uuid)') IS NOT NULL
     OR to_regprocedure('public.unfreeze_group_work_order_split(uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public.void_group_work_order(uuid, uuid, text)') IS NOT NULL
     OR to_regprocedure('public.rekey_group_work_order(uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public.revoke_group_client_signoff(uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public.group_work_order_assignment_covers(uuid, uuid, date)') IS NOT NULL
     OR to_regprocedure('public.group_client_signoff_counts(uuid)') IS NOT NULL
     OR to_regprocedure('public.group_work_order_time_entries_guard()') IS NOT NULL
     OR to_regprocedure('public.group_work_order_refuse_late_joiner()') IS NOT NULL
     OR to_regprocedure('public.group_work_order_shares_frozen_guard()') IS NOT NULL
     OR to_regprocedure('public.trade_invoice_lines_group_share_snapshot()') IS NOT NULL
     OR to_regprocedure('public.group_work_order_line_is_normal_pay(text, uuid)') IS NOT NULL
     OR to_regprocedure('public.group_work_order_lock_job(uuid)') IS NOT NULL
     OR to_regprocedure('public.remove_group_work_order_participant(uuid, uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public.group_work_orders_refuse_existing_pay()') IS NOT NULL
     OR to_regprocedure('public.group_work_orders_void_permanent()') IS NOT NULL
     OR to_regprocedure('public.group_work_order_signature_ok(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: group work order tables and functions must be removed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname IN (
      'trg_trade_invoice_lines_group_share_snapshot',
      'trg_group_work_orders_refuse_existing_pay',
      'trg_group_work_orders_void_permanent'
    )
  ) THEN
    RAISE EXCEPTION 'rollback: the share snapshot trigger must be removed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.job_client_signoffs
    WHERE id = 'd2140000-0000-4000-8000-0000000000e3'
      AND method = 'share_link'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.job_client_signoffs
    WHERE id = 'd2140000-0000-4000-8000-0000000000e4'
      AND method = 'revoked'
  ) THEN
    RAISE EXCEPTION 'rollback: share_link and revoked sign-offs must remain';
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
    WHERE flag_name IN (
      'group_work_order_client_link_send_v1',
      'group_work_order_v1',
      'completion_pack_client_email_v1'
    )
  ) THEN
    RAISE EXCEPTION 'rollback: the group flags must be removed';
  END IF;
  IF to_regclass('public.job_client_signoffs') IS NULL THEN
    RAISE EXCEPTION 'rollback: job_client_signoffs must remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'job_client_signoffs'
      AND column_name = 'captured_device'
  ) THEN
    RAISE EXCEPTION 'rollback: job_client_signoffs.captured_device must be removed';
  END IF;
  IF (
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conname = 'job_client_signoffs_method_check'
      AND conrelid = 'public.job_client_signoffs'::regclass
  ) NOT LIKE '%on_site%'
     OR (
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conname = 'job_client_signoffs_method_check'
      AND conrelid = 'public.job_client_signoffs'::regclass
  ) NOT LIKE '%office_waiver%'
     OR (
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conname = 'job_client_signoffs_method_check'
      AND conrelid = 'public.job_client_signoffs'::regclass
  ) NOT LIKE '%share_link%'
     OR (
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conname = 'job_client_signoffs_method_check'
      AND conrelid = 'public.job_client_signoffs'::regclass
  ) NOT LIKE '%revoked%' THEN
    RAISE EXCEPTION 'rollback: the widened sign-off method check must stay';
  END IF;
  IF (
    SELECT tgenabled FROM pg_trigger
    WHERE tgname = 'trg_job_client_signoffs_append_only'
      AND tgrelid = 'public.job_client_signoffs'::regclass
  ) IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'rollback: the sign-off append-only trigger must stay enabled';
  END IF;
END $$;
