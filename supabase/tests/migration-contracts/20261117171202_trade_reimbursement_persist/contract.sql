BEGIN;
-- Lift unrelated fixture guards only. The reimbursement guards stay enabled.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'jobs', 'trade_invoices', 'trade_invoice_lines', 'expense_receipts'] LOOP
    FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid = format('public.%I', t)::regclass
      AND NOT tgisinternal AND tgname <> 'trade_invoice_lines_reimbursement_once' LOOP
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', t, c.tgname);
    END LOOP;
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = format('public.%I', t)::regclass
      AND contype IN ('f','c','u','x') AND conname NOT IN ('trade_invoice_lines_reimbursement_check', 'trade_invoice_lines_receipt_only_on_reimbursement') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c.conname);
    END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid = format('public.%I', t)::regclass
      AND attnum > 0 AND NOT attisdropped AND attnotnull AND attname <> 'id' LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', t, c.attname);
    END LOOP;
  END LOOP;
END $$;
INSERT INTO public.jobs(id, org_id, job_number, type, status) VALUES
('03000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST-REIMB','fencing','complete');
INSERT INTO public.users(id, org_id, name) VALUES
('03000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','ZZTEST trade');
INSERT INTO public.expense_receipts(id) VALUES ('03000000-0000-4000-8000-000000000003');
UPDATE public.users SET role = 'trade' WHERE id = '03000000-0000-4000-8000-000000000002';
DO $$ DECLARE invoice uuid; stored record; BEGIN
  invoice := public.persist_weekly_trade_invoice_v1(
    '{"org_id":"00000000-0000-0000-0000-000000000001","user_id":"03000000-0000-4000-8000-000000000002","week_start":"2026-11-16","week_end":"2026-11-22","status":"draft","invoice_source":"hourly","subtotal_ex":640,"gross_earned":640,"gst_on":false,"gst":0,"total_inc":640,"super_rate":0.12,"super_basis":"inclusive_12_112_v1","super_base_ex":560,"super_amount":60,"net_pay":580}'::jsonb,
    '[{"line_type":"labour","description":"ZZTEST hours","job_id":"03000000-0000-4000-8000-000000000001","line_total_ex":560},{"line_type":"reimbursement","description":"Reimbursement - ZZTEST receipt","job_id":"03000000-0000-4000-8000-000000000001","expense_receipt_id":"03000000-0000-4000-8000-000000000003","quantity":1,"unit_rate":80,"line_total_ex":80,"office_review_status":"awaiting","office_review_note":"reimbursement"}]'::jsonb, NULL);
  SELECT * INTO stored FROM public.trade_invoice_lines WHERE trade_invoice_id = invoice AND line_type = 'reimbursement';
  IF stored.expense_receipt_id IS DISTINCT FROM '03000000-0000-4000-8000-000000000003'::uuid OR stored.office_review_status IS DISTINCT FROM 'awaiting' OR stored.office_review_note IS DISTINCT FROM 'reimbursement' OR stored.line_total_ex <> 80 THEN RAISE EXCEPTION 'ZZTEST receipt and office hold did not persist'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id = invoice AND gross_earned = 640 AND super_base_ex = 560 AND super_amount = 60 AND net_pay = 580) THEN RAISE EXCEPTION 'ZZTEST reimbursement week money did not persist'; END IF;
END $$;
ROLLBACK;
