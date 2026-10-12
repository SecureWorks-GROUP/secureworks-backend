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
     OR to_regprocedure('public.approve_job_work_order(uuid, uuid, text, timestamptz)') IS NOT NULL
     OR to_regprocedure('public.carry_work_order_variations(uuid, uuid)') IS NOT NULL THEN
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

-- The draft-replacing functions run again without the carry call.
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_header jsonb;
  v_lines jsonb;
  v_draft uuid;
  v_saved uuid;
  v_submitted uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.users (id, org_id, name, role)
  VALUES ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'Trade', 'crew')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'scheduled', 'WOC-RB-2');
  v_header := jsonb_build_object(
    'org_id', '00000000-0000-0000-0000-000000000001', 'user_id', 'aaaaaaaa-0000-0000-0000-00000000000a',
    'week_start', '2026-10-05', 'week_end', '2026-10-11',
    'total_hours', 5, 'total_breaks_minutes', 0,
    'subtotal_ex', 200, 'gst', 0, 'total_inc', 200, 'gst_on', false,
    'super_rate', 0.12, 'super_amount', 24, 'gross_earned', 200, 'net_pay', 188,
    'invoice_source', 'hourly', 'status', 'draft');
  v_lines := jsonb_build_array(
    jsonb_build_object('job_id', v_job, 'job_number', 'WOC-RB-2', 'line_type', 'labour',
      'description', 'Clocked labour', 'quantity', 5, 'unit', 'hr', 'unit_rate', 40,
      'total_hours', 5, 'hourly_rate', 40, 'line_total_ex', 200, 'line_position', 0));
  v_draft := public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);
  v_saved := public.persist_weekly_trade_invoice_v1(v_header, v_lines, v_draft);
  INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay)
  VALUES (v_submitted, '00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'pending_acknowledgment', 200, 0, 200, false, 0.12, 24, 200, 188);
  PERFORM public.replace_trade_invoice_draft_v1(v_saved, v_submitted, 'aaaaaaaa-0000-0000-0000-00000000000a', ARRAY[]::uuid[]);
  IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE id IN (v_draft, v_saved))
     OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id = v_submitted) THEN
    RAISE EXCEPTION 'rollback: replacing a draft invoice must work as it did before';
  END IF;
END $$;
ROLLBACK;
