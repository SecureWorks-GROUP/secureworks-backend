-- Executed against disposable PostgreSQL after the migration.
BEGIN;

DO $$
DECLARE
  required_name text;
BEGIN
  FOREACH required_name IN ARRAY ARRAY[
    'trade_invoices_weekly_totals_check',
    'trade_invoice_lines_typed_deduction_sign_check',
    'trade_invoice_lines_final_deduction_scope_check',
    'trade_invoice_lines_source_work_order_fk',
    'trade_invoice_lines_source_trade_line_fk',
    'trade_invoice_lines_deduction_user_fk',
    'trade_invoice_lines_deduction_assignment_fk',
    'trade_invoice_lines_deduction_trade_rate_fk'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = required_name
    ) THEN
      RAISE EXCEPTION 'required weekly invoice constraint missing: %', required_name;
    END IF;
  END LOOP;
  IF to_regprocedure(
    'public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'weekly invoice persistence function missing';
  END IF;
  IF to_regprocedure(
    'public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'single-work-order invoice persistence function missing';
  END IF;
  IF to_regprocedure(
    'public.trade_invoice_first_numeric_candidate_v1(jsonb,numeric)'
  ) IS NULL THEN
    RAISE EXCEPTION 'weekly invoice numeric helper function missing';
  END IF;
  IF to_regprocedure(
    'public.trade_invoice_work_order_scope_lines_v1(jsonb)'
  ) IS NULL THEN
    RAISE EXCEPTION 'weekly invoice scope helper function missing';
  END IF;
END;
$$;

INSERT INTO public.users (id, org_id, name) VALUES
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Henry'),
  ('20000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'Isaac');

INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('20000000-0000-4000-8000-000000000010', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'SWF-TEST-31');

INSERT INTO public.work_orders (
  id, org_id, job_id, status, scope_items, scheduled_date, completed_at
) VALUES
(
  '20000000-0000-4000-8000-000000000020',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000010',
  'complete',
  '[{"description":"Fence Installation","quantity":1,"unit":"ea","unit_price":100}]',
  '2026-08-18',
  NULL
), (
  '20000000-0000-4000-8000-000000000021',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000010',
  'complete',
  '[{"description":"Fence Installation","quantity":1,"unit":"ea","unit_price":100}]',
  '2026-08-18',
  NULL
), (
  '20000000-0000-4000-8000-000000000022',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000010',
  'complete',
  '[{"description":"Fence Installation","quantity":1,"unit":"ea","unit_price":100}]',
  '2026-08-18',
  NULL
), (
  '20000000-0000-4000-8000-000000000023',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000010',
  'complete',
  '[{"description":"Fence Installation","quantity":"","metres":12,"unit_price":"","rate":35}]',
  '2026-08-18',
  NULL
), (
  '20000000-0000-4000-8000-000000000024',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000010',
  'complete',
  '[{"description":"Fence Installation","quantity":1,"unit":"ea","unit_price":120}]',
  '2026-08-25',
  NULL
), (
  '20000000-0000-4000-8000-000000000025',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000010',
  'complete',
  '[{"description":"Fence Installation","quantity":1,"unit":"ea","unit_price":100}]',
  NULL,
  '2026-08-30T16:30:00Z'
), (
  '20000000-0000-4000-8000-000000000026',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000010',
  'complete',
  '[{"description":"Fence Installation","quantity":1,"unit":"ea","unit_price":100}]',
  '2026-09-08',
  NULL
), (
  '20000000-0000-4000-8000-000000000027',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000010',
  'accepted',
  '[{"description":"Fence Installation","quantity":1,"unit":"ea","unit_price":100}]',
  '2026-09-15',
  NULL
);

INSERT INTO public.job_assignments (id, job_id, user_id) VALUES
  ('20000000-0000-4000-8000-000000000030', '20000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000002');

INSERT INTO public.trade_rates (
  id, org_id, user_id, hourly_rate, effective_from
) VALUES (
  '20000000-0000-4000-8000-000000000040',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  40,
  '2026-01-01'
), (
  '20000000-0000-4000-8000-000000000041',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  45,
  '2026-08-01'
);

-- Invoice #31's server-owned header arithmetic is accepted exactly.
INSERT INTO public.trade_invoices (
  id, org_id, user_id, week_start, invoice_source,
  subtotal_ex, gst, total_inc, status,
  gst_on, super_rate, super_amount, gross_earned, net_pay,
  job_grand_total_ex, final_deductions_total_ex, to_be_paid_ex
) VALUES (
  '20000000-0000-4000-8000-000000000050',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '2026-08-24',
  'weekly_work_order',
  4813.40, 0, 4813.40, 'draft',
  false, 0.12, 577.61, 4813.40, 4235.79,
  5163.40, 350.00, 4813.40
);

-- The exact source identities and negative signs are persistable.
INSERT INTO public.trade_invoice_lines (
  id, trade_invoice_id, job_id, job_number, line_type, description,
  quantity, unit, unit_rate, line_total_ex, source_work_order_id,
  deduction_user_id, deduction_assignment_id, deduction_trade_rate_id,
  line_position
) VALUES (
  '20000000-0000-4000-8000-000000000060',
  '20000000-0000-4000-8000-000000000050',
  '20000000-0000-4000-8000-000000000010',
  'SWF-TEST-31',
  'labour_deduction',
  'Labour - Isaac',
  2, 'hr', -40, -80,
  '20000000-0000-4000-8000-000000000020',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000030',
  '20000000-0000-4000-8000-000000000040',
  0
), (
  '20000000-0000-4000-8000-000000000061',
  '20000000-0000-4000-8000-000000000050',
  NULL, NULL,
  'final_payout_deduction',
  'Car Loan',
  1, 'ea', -350, -350,
  NULL, NULL, NULL, NULL,
  1
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.v_trade_charge_resolved
    WHERE line_id = '20000000-0000-4000-8000-000000000060'
      AND cost_lane = 'labour'
      AND resolved_job_id = '20000000-0000-4000-8000-000000000010'
  ) THEN
    RAISE EXCEPTION 'typed labour deduction did not resolve to the job cost lane';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.v_trade_charge_resolved
    WHERE line_id = '20000000-0000-4000-8000-000000000061'
      AND cost_lane = 'unclassified'
      AND resolved_job_id IS NULL
  ) THEN
    RAISE EXCEPTION 'final payout deduction did not remain non-job scoped';
  END IF;
END;
$$;

-- Header arithmetic cannot be client-claimed.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.trade_invoices (
      id, org_id, user_id, week_start, invoice_source,
      subtotal_ex, gst, total_inc, status,
      gst_on, super_rate, super_amount, gross_earned, net_pay,
      job_grand_total_ex, final_deductions_total_ex, to_be_paid_ex
    ) VALUES (
      '20000000-0000-4000-8000-000000000051',
      '00000000-0000-0000-0000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '2026-08-24', 'weekly_work_order',
      4813.40, 0, 4813.40, 'draft',
      false, 0.12, 577.61, 4813.40, 4235.79,
      5163.40, 349.00, 4813.40
    );
    RAISE EXCEPTION 'incorrect weekly header arithmetic was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Typed deductions cannot be stored as positive charges.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.trade_invoice_lines (
      trade_invoice_id, job_id, job_number, line_type, line_total_ex
    ) VALUES (
      '20000000-0000-4000-8000-000000000050',
      '20000000-0000-4000-8000-000000000010',
      'SWF-TEST-31', 'materials_deduction', 5
    );
    RAISE EXCEPTION 'positive typed deduction was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Final payout deductions cannot be smuggled into a job block.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.trade_invoice_lines (
      trade_invoice_id, job_id, job_number, line_type, line_total_ex
    ) VALUES (
      '20000000-0000-4000-8000-000000000050',
      '20000000-0000-4000-8000-000000000010',
      'SWF-TEST-31', 'final_payout_deduction', -5
    );
    RAISE EXCEPTION 'job-scoped final payout deduction was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

-- The database boundary serializes draft replacement and source claiming.
-- Once its organization advisory lock is acquired, concurrent callers observe
-- one of these same ordered states: replace the one draft or refuse a live use.
DO $$
DECLARE
  v_header jsonb;
  v_lines jsonb;
  v_first_draft uuid;
  v_second_draft uuid;
  v_submitted uuid;
  v_single_invoice uuid;
  v_single_header jsonb;
  v_single_lines jsonb;
  v_count integer;
BEGIN
  v_header := jsonb_build_object(
    'org_id', '00000000-0000-0000-0000-000000000001',
    'user_id', '20000000-0000-4000-8000-000000000001',
    'week_start', '2026-08-17',
    'week_end', '2026-08-23',
    'total_hours', 0,
    'total_breaks_minutes', 0,
    'subtotal_ex', 100,
    'gst', 0,
    'total_inc', 100,
    'gst_on', false,
    'super_rate', 0.12,
    'super_amount', 12,
    'gross_earned', 100,
    'net_pay', 88,
    'invoice_source', 'weekly_work_order',
    'job_grand_total_ex', 100,
    'final_deductions_total_ex', 0,
    'to_be_paid_ex', 100,
    'status', 'draft'
  );
  v_lines := jsonb_build_array(jsonb_build_object(
    'job_id', '20000000-0000-4000-8000-000000000010',
    'job_number', 'SWF-TEST-31',
    'client_name', 'Test Client',
    'line_type', 'labour',
    'description', 'Fence Installation',
    'quantity', 1,
    'unit', 'ea',
    'unit_rate', 100,
    'line_total_ex', 100,
    'source_work_order_id', '20000000-0000-4000-8000-000000000021',
    'line_date', '2026-08-18',
    'line_position', 0
  ));

  v_first_draft := public.persist_weekly_trade_invoice_v1(
    v_header,
    v_lines,
    NULL
  );
  v_second_draft := public.persist_weekly_trade_invoice_v1(
    v_header,
    v_lines,
    v_first_draft
  );

  SELECT count(*) INTO v_count
  FROM public.trade_invoices
  WHERE user_id = '20000000-0000-4000-8000-000000000001'
    AND week_start = '2026-08-17'
    AND status = 'draft';
  IF v_count <> 1
     OR EXISTS (SELECT 1 FROM public.trade_invoices WHERE id = v_first_draft)
     OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id = v_second_draft) THEN
    RAISE EXCEPTION 'weekly draft replacement did not converge on one draft';
  END IF;

  v_header := v_header || jsonb_build_object(
    'status', 'pending_acknowledgment',
    'invoice_number', 'SW-INV-EH-260827-031',
    'submitted_at', '2026-08-27T00:00:00Z'
  );
  v_submitted := public.persist_weekly_trade_invoice_v1(
    v_header,
    v_lines,
    v_second_draft
  );

  IF EXISTS (
    SELECT 1 FROM public.trade_invoices
    WHERE user_id = '20000000-0000-4000-8000-000000000001'
      AND week_start = '2026-08-17'
      AND status = 'draft'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.trade_invoice_lines
    WHERE trade_invoice_id = v_submitted
      AND source_work_order_id = '20000000-0000-4000-8000-000000000021'
  ) THEN
    RAISE EXCEPTION 'weekly submit did not atomically replace the draft and keep its source claim';
  END IF;

  BEGIN
    PERFORM public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);
    RAISE EXCEPTION 'duplicate live weekly source claim was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  v_single_header := jsonb_build_object(
    'org_id', '00000000-0000-0000-0000-000000000001',
    'user_id', '20000000-0000-4000-8000-000000000001',
    'work_order_id', '20000000-0000-4000-8000-000000000021',
    'job_id', '20000000-0000-4000-8000-000000000010',
    'source_work_order_date', '2026-08-18',
    'invoice_source', 'work_order',
    'subtotal_ex', 100,
    'gst', 0,
    'total_inc', 100,
    'gst_on', false,
    'super_rate', 0.12,
    'super_amount', 12,
    'gross_earned', 100,
    'net_pay', 88,
    'status', 'draft'
  );
  v_single_lines := jsonb_build_array(jsonb_build_object(
    'job_id', '20000000-0000-4000-8000-000000000010',
    'job_number', 'SWF-TEST-31',
    'description', 'Fence Installation',
    'quantity', 1,
    'unit', 'ea',
    'unit_rate', 100,
    'line_total_ex', 100,
    'line_date', '2026-08-18'
  ));

  BEGIN
    PERFORM public.persist_trade_work_order_invoice_v1(
      v_single_header,
      v_single_lines,
      NULL
    );
    RAISE EXCEPTION 'single-work-order route claimed a live weekly source';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  v_single_header := v_single_header || jsonb_build_object(
    'work_order_id', '20000000-0000-4000-8000-000000000022'
  );
  v_single_invoice := public.persist_trade_work_order_invoice_v1(
    v_single_header,
    v_single_lines,
    NULL
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.trade_invoices
    WHERE id = v_single_invoice
      AND work_order_id = '20000000-0000-4000-8000-000000000022'
  ) THEN
    RAISE EXCEPTION 'single-work-order source claim was not persisted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.trade_invoice_lines
    WHERE trade_invoice_id = v_single_invoice
      AND description = 'Fence Installation'
      AND line_type = 'labour'
  ) THEN
    RAISE EXCEPTION 'single-work-order positive line did not preserve labour classification';
  END IF;

  v_single_header := v_single_header || jsonb_build_object(
    'work_order_id', '20000000-0000-4000-8000-000000000024',
    'source_work_order_date', '2026-08-25'
  );
  v_single_lines := jsonb_build_array((v_single_lines->0) || jsonb_build_object(
    'line_date', '2026-08-25'
  ));
  BEGIN
    PERFORM public.persist_trade_work_order_invoice_v1(
      v_single_header,
      v_single_lines,
      NULL
    );
    RAISE EXCEPTION 'stale single-work-order source scope was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  v_lines := jsonb_build_array((v_lines->0) || jsonb_build_object(
    'source_work_order_id', '20000000-0000-4000-8000-000000000022'
  ));
  BEGIN
    PERFORM public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);
    RAISE EXCEPTION 'weekly route claimed a live single-work-order source';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  v_header := jsonb_build_object(
    'org_id', '00000000-0000-0000-0000-000000000001',
    'user_id', '20000000-0000-4000-8000-000000000001',
    'week_start', '2026-08-17',
    'week_end', '2026-08-23',
    'total_hours', 0,
    'total_breaks_minutes', 0,
    'subtotal_ex', 420,
    'gst', 0,
    'total_inc', 420,
    'gst_on', false,
    'super_rate', 0.12,
    'super_amount', 50.40,
    'gross_earned', 420,
    'net_pay', 369.60,
    'invoice_source', 'weekly_work_order',
    'job_grand_total_ex', 420,
    'final_deductions_total_ex', 0,
    'to_be_paid_ex', 420,
    'status', 'draft'
  );
  v_lines := jsonb_build_array(jsonb_build_object(
    'job_id', '20000000-0000-4000-8000-000000000010',
    'job_number', 'SWF-TEST-31',
    'client_name', 'Test Client',
    'line_type', 'labour',
    'description', 'Fence Installation',
    'quantity', 12,
    'unit', 'm',
    'unit_rate', 35,
    'line_total_ex', 420,
    'source_work_order_id', '20000000-0000-4000-8000-000000000023',
    'line_date', '2026-08-18'
  ));
  PERFORM public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);

  v_header := v_header || jsonb_build_object(
    'week_start', '2026-08-24',
    'week_end', '2026-08-30',
    'subtotal_ex', 100,
    'total_inc', 100,
    'gross_earned', 100,
    'net_pay', 88,
    'job_grand_total_ex', 100,
    'to_be_paid_ex', 100,
    'super_amount', 12
  );
  v_lines := jsonb_build_array(jsonb_build_object(
    'job_id', '20000000-0000-4000-8000-000000000010',
    'job_number', 'SWF-TEST-31',
    'line_type', 'labour',
    'description', 'Fence Installation',
    'quantity', 1,
    'unit', 'ea',
    'unit_rate', 100,
    'line_total_ex', 100,
    'source_work_order_id', '20000000-0000-4000-8000-000000000024',
    'line_date', '2026-08-25'
  ));
  BEGIN
    PERFORM public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);
    RAISE EXCEPTION 'stale weekly source scope was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  v_header := v_header || jsonb_build_object(
    'week_start', '2026-08-31',
    'week_end', '2026-09-06'
  );
  v_lines := jsonb_build_array(jsonb_build_object(
    'job_id', '20000000-0000-4000-8000-000000000010',
    'job_number', 'SWF-TEST-31',
    'line_type', 'labour',
    'description', 'Fence Installation',
    'quantity', 1,
    'unit', 'ea',
    'unit_rate', 100,
    'line_total_ex', 100,
    'source_work_order_id', '20000000-0000-4000-8000-000000000025',
    'line_date', '2026-08-31'
  ));
  PERFORM public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);

  v_header := v_header || jsonb_build_object(
    'week_start', '2026-09-07',
    'week_end', '2026-09-13',
    'subtotal_ex', 60,
    'total_inc', 60,
    'gross_earned', 60,
    'net_pay', 52.80,
    'job_grand_total_ex', 60,
    'to_be_paid_ex', 60,
    'super_amount', 7.20
  );
  v_lines := jsonb_build_array(
    jsonb_build_object(
      'job_id', '20000000-0000-4000-8000-000000000010',
      'job_number', 'SWF-TEST-31',
      'line_type', 'labour',
      'description', 'Fence Installation',
      'quantity', 1,
      'unit', 'ea',
      'unit_rate', 100,
      'line_total_ex', 100,
      'source_work_order_id', '20000000-0000-4000-8000-000000000026',
      'line_date', '2026-09-08'
    ),
    jsonb_build_object(
      'job_id', '20000000-0000-4000-8000-000000000010',
      'job_number', 'SWF-TEST-31',
      'line_type', 'labour_deduction',
      'description', 'Labour - Isaac',
      'quantity', 1,
      'unit', 'hr',
      'unit_rate', -40,
      'line_total_ex', -40,
      'source_work_order_id', '20000000-0000-4000-8000-000000000026',
      'line_date', '2026-09-08',
      'deduction_user_id', '20000000-0000-4000-8000-000000000002',
      'deduction_assignment_id', '20000000-0000-4000-8000-000000000030',
      'deduction_trade_rate_id', '20000000-0000-4000-8000-000000000040'
    )
  );
  BEGIN
    PERFORM public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);
    RAISE EXCEPTION 'stale labour deduction rate was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  v_header := v_header || jsonb_build_object(
    'week_start', '2026-09-14',
    'week_end', '2026-09-20',
    'subtotal_ex', 100,
    'total_inc', 100,
    'gross_earned', 100,
    'net_pay', 88,
    'job_grand_total_ex', 100,
    'to_be_paid_ex', 100,
    'super_amount', 12
  );
  v_lines := jsonb_build_array(jsonb_build_object(
    'job_id', '20000000-0000-4000-8000-000000000010',
    'job_number', 'SWF-TEST-31',
    'line_type', 'labour',
    'description', 'Fence Installation',
    'quantity', 1,
    'unit', 'ea',
    'unit_rate', 100,
    'line_total_ex', 100,
    'source_work_order_id', '20000000-0000-4000-8000-000000000027',
    'line_date', '2026-09-15'
  ));
  BEGIN
    PERFORM public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);
    RAISE EXCEPTION 'incomplete weekly work order was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END;
$$;

ROLLBACK;
