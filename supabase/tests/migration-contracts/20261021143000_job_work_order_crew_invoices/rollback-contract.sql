-- After the down migration the seven switches, the backup approver, the
-- office-review columns and the new functions are gone. Automatic issue
-- remains, and a make-safe job still cannot open a work order.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag_name IN (
      'job_work_order_all_types_v1',
      'job_work_order_active_backfill_v1',
      'job_work_order_office_fill_v1',
      'crew_invoice_on_job_work_order_v1',
      'crew_invoice_line_office_review_v1',
      'crew_invoice_requires_job_work_order_v1',
      'retire_crew_work_orders_v1'
    )
  ) THEN
    RAISE EXCEPTION 'rollback: the crew-invoice work order flags must be removed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'work_order_settings'
      AND column_name = 'backup_approver_user_ids'
  ) THEN
    RAISE EXCEPTION 'rollback: backup_approver_user_ids must be removed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trade_invoice_lines'
      AND column_name IN (
        'office_review_status', 'office_reviewed_by', 'office_reviewed_at', 'office_review_note'
      )
  ) THEN
    RAISE EXCEPTION 'rollback: the office review columns must be removed';
  END IF;
  IF to_regprocedure('public.preview_active_job_work_orders()') IS NOT NULL
     OR to_regprocedure('public.apply_active_job_work_orders()') IS NOT NULL
     OR to_regprocedure('public.apply_active_job_work_orders(uuid[])') IS NOT NULL
     OR to_regprocedure('public.job_invoice_work_order_id(uuid)') IS NOT NULL
     OR to_regprocedure('public.job_work_order_recent_activity(uuid)') IS NOT NULL
     OR to_regprocedure('public.job_work_order_crew_invoice_rollback_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: the backfill and stamp helpers must be removed';
  END IF;
  IF to_regprocedure('public.auto_issue_job_work_order(uuid, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'rollback: automatic issue must remain';
  END IF;
END $$;

BEGIN;
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('9913309f-35ae-4a71-8e1f-f704ecc526ea', '00000000-0000-0000-0000-000000000001', 'Shaun', 'ops_manager')
ON CONFLICT (id) DO NOTHING;
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
BEGIN
  BEGIN
    INSERT INTO public.jobs (id, org_id, type, status, job_number)
    VALUES (v_job, '00000000-0000-0000-0000-000000000001', 'makesafe', 'scheduled', 'JWOCI-RB-1');
    IF EXISTS (SELECT 1 FROM public.work_orders WHERE job_id = v_job AND kind = 'job') THEN
      RAISE EXCEPTION 'rollback: a make-safe job must not open a work order';
    END IF;
    PERFORM public.ensure_job_work_order_draft(v_job, 'manual');
    RAISE EXCEPTION 'rollback: ensure must still refuse a make-safe job';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%fencing%' OR SQLERRM NOT LIKE '%patio%' THEN
      RAISE EXCEPTION 'rollback: the refusal must still name fencing and patio (%).', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK;
