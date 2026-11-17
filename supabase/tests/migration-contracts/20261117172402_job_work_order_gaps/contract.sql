BEGIN;
-- Isolate this read's fixtures from unrelated business-write triggers.
SET LOCAL session_replication_role = replica;
DO $$
DECLARE
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  job uuid := gen_random_uuid();
  wo uuid := gen_random_uuid();
  inv1 uuid := gen_random_uuid();
  inv2 uuid := gen_random_uuid();
  inv_other uuid := gen_random_uuid();
  result jsonb;
  row jsonb;
BEGIN
  INSERT INTO public.jobs(id, org_id, job_number, type, status, created_at)
    VALUES(job, org, 'ZZTEST-GAP', 'makesafe', 'scheduled', '2026-01-01');
  result := public.job_work_order_gaps(org);
  IF result->'counts' <> '{"no_work_order":1,"no_amount":0,"jobs_with_held_lines":0}'::jsonb
     OR result->'jobs'->0->>'reason' IS DISTINCT FROM 'no_work_order' THEN
    RAISE EXCEPTION 'ZZTEST open job without work order missing';
  END IF;
  INSERT INTO public.work_orders(id, org_id, job_id, wo_number, kind, status)
    VALUES(wo, org, job, 'ZZTEST-WO', 'job', 'draft');
  result := public.job_work_order_gaps(org);
  IF result->'jobs'->0->>'reason' IS DISTINCT FROM 'no_amount'
     OR result->'jobs'->0->>'work_order_id' IS DISTINCT FROM wo::text THEN
    RAISE EXCEPTION 'ZZTEST draft with null amount not listed';
  END IF;
  UPDATE public.work_orders SET agreed_labour_ex = 0 WHERE id = wo;
  IF public.job_work_order_gaps(org)->'jobs'->0->>'reason' IS DISTINCT FROM 'no_amount' THEN
    RAISE EXCEPTION 'ZZTEST draft must still await approval';
  END IF;
  UPDATE public.work_orders SET status = 'approved', approved_at = '2026-01-02',
    approved_by = gen_random_uuid(), sealed_content_hash = 'ZZTEST-seal' WHERE id = wo;
  IF public.job_work_order_gaps(org)->'jobs' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'ZZTEST approved zero must not be a gap';
  END IF;
  UPDATE public.work_orders SET agreed_labour_ex = 1 WHERE id = wo;
  IF public.job_work_order_gaps(org)->'jobs' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'ZZTEST approved positive amount must not be a gap';
  END IF;
  -- These are disposable fixture rows only, never sealed operational rows.
  DELETE FROM public.work_orders WHERE id = wo;
  UPDATE public.jobs SET status = 'complete' WHERE id = job;
  IF public.job_work_order_gaps(org)->'jobs' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'ZZTEST closed job without waiting pay was listed';
  END IF;
  INSERT INTO public.trade_invoices(id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay, invoice_number) VALUES
    (inv1, org, gen_random_uuid(), 'draft', 0, 0, 0, false, .12, 0, 0, 0, 'ZZTEST-INVOICE-1'),
    (inv2, org, gen_random_uuid(), 'draft', 0, 0, 0, false, .12, 0, 0, 0, 'ZZTEST-INVOICE-2'),
    (inv_other, other_org, gen_random_uuid(), 'draft', 0, 0, 0, false, .12, 0, 0, 0, 'ZZTEST-INVOICE-OTHER');
  INSERT INTO public.trade_invoice_lines(trade_invoice_id, job_id, line_type, line_total_ex,
    office_review_status, hold_reason, held_at) VALUES
    (inv1, job, 'labour', 3.25, 'awaiting', 'no_work_order', '2026-01-03');
  IF (public.job_work_order_gaps(org)->'jobs'->0->>'held_lines')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'ZZTEST closed job with one waiting line must be listed';
  END IF;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id, job_id, line_type, line_total_ex,
    office_review_status, hold_reason, held_at) VALUES
    (inv2, job, 'labour', 4.75, 'queried', 'hourly_no_maximum', '2026-01-04'),
    (inv1, job, 'labour', 99, 'awaiting', 'over_amount', '2026-01-01'),
    (inv1, job, 'labour', 99, 'approved', 'no_work_order', '2026-01-01'),
    (inv_other, job, 'labour', 99, 'awaiting', 'no_work_order', '2026-01-01');
  result := public.job_work_order_gaps(org);
  row := result->'jobs'->0;
  IF (row->>'held_lines')::int IS DISTINCT FROM 2 OR (row->>'held_trades')::int IS DISTINCT FROM 2
     OR (row->>'held_amount_ex')::numeric IS DISTINCT FROM 8
     OR (row->>'oldest_held_at')::timestamptz IS DISTINCT FROM '2026-01-03'::timestamptz
     OR result->'counts' <> '{"no_work_order":1,"no_amount":0,"jobs_with_held_lines":1}'::jsonb THEN
    RAISE EXCEPTION 'ZZTEST waiting lines count, people, sum or oldest date differs';
  END IF;
  INSERT INTO public.jobs(org_id, job_number, type, status, created_at) VALUES
    (org, 'ZZTEST-OPEN-OLDER', 'makesafe', 'scheduled', '2025-01-01'),
    (other_org, 'ZZTEST-OTHER-ORG', 'makesafe', 'scheduled', '2025-01-01');
  result := public.job_work_order_gaps(org);
  IF jsonb_array_length(result->'jobs') <> 2 OR result->'jobs'->0->>'job_id' <> job::text
     OR result->'jobs'->1->>'job_number' <> 'ZZTEST-OPEN-OLDER' THEN
    RAISE EXCEPTION 'ZZTEST waiting job must sort first and other company must stay out';
  END IF;
  IF row ? 'user_id' OR row ? 'trade_name' OR row ? 'client_name'
     OR has_function_privilege('anon', 'public.job_work_order_gaps(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.job_work_order_gaps(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.job_work_order_gaps(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST gap reader exposed personal fields or browser access';
  END IF;
END $$;
SELECT 'PASS: P1-05.1 gap reasons, explicit zero, held pay sum, company and access' AS result;
ROLLBACK;
