-- After the down migration the legacy work order surface is back and every
-- job work order object is gone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND ((table_name = 'work_orders' AND column_name IN ('kind', 'agreed_labour_ex', 'approved_by', 'sealed_content_hash'))
               OR (table_name = 'jobs' AND column_name = 'work_order_id')
               OR (table_name = 'trade_invoice_lines' AND column_name = 'job_work_order_id'))) THEN
    RAISE EXCEPTION 'rollback: job work order columns must be removed';
  END IF;
  IF to_regclass('public.work_order_variations') IS NOT NULL
     OR to_regclass('public.work_order_settings') IS NOT NULL
     OR to_regprocedure('public.approve_job_work_order(uuid, uuid, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: job work order tables and functions must be removed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name IN ('work_order_variation_emails_v1', 'job_work_order_backfill_v1',
                                'work_order_terminal_approval_v1')) THEN
    RAISE EXCEPTION 'rollback: the job work order flags must be removed';
  END IF;
END $$;

BEGIN;
DO $$
DECLARE v_job uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'quoted', 'WOC-RB-1');
  INSERT INTO public.work_orders (org_id, job_id, wo_number, status) VALUES
    ('00000000-0000-0000-0000-000000000001', v_job, 'WO-RB', 'sent');
  BEGIN
    UPDATE public.work_orders SET status = 'approved' WHERE wo_number = 'WO-RB';
    RAISE EXCEPTION 'rollback: the legacy status check must be restored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
