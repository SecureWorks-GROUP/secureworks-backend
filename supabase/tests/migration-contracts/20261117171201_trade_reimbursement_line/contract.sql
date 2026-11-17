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
INSERT INTO public.trade_invoices(id, org_id, user_id, status, invoice_number, week_start, subtotal_ex, gross_earned, gst_on, gst, total_inc, super_amount, net_pay, super_rate) VALUES
('03000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000001','03000000-0000-4000-8000-000000000002','submitted','ZZTEST-REIMB-1','2026-11-16',80,80,false,0,80,0,80,0),
('03000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000001','03000000-0000-4000-8000-000000000002','submitted','ZZTEST-REIMB-2','2026-11-16',80,80,false,0,80,0,80,0);
DO $$ BEGIN
  BEGIN
    INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,line_total_ex) VALUES ('03000000-0000-4000-8000-000000000004','reimbursement',80);
    RAISE EXCEPTION 'ZZTEST missing receipt was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,line_total_ex,expense_receipt_id) VALUES ('03000000-0000-4000-8000-000000000004','labour',80,'03000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'ZZTEST labour receipt was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,job_id,job_number,line_type,description,line_total_ex,expense_receipt_id) VALUES
('03000000-0000-4000-8000-000000000006','03000000-0000-4000-8000-000000000004','03000000-0000-4000-8000-000000000001','ZZTEST-REIMB','reimbursement','Reimbursement - ZZTEST receipt',80,'03000000-0000-4000-8000-000000000003');
DO $$ DECLARE n int; BEGIN
  BEGIN
    INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,line_total_ex,expense_receipt_id) VALUES ('03000000-0000-4000-8000-000000000005','reimbursement',80,'03000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'ZZTEST duplicate receipt was accepted';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM <> 'reimbursement_already_claimed' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO n FROM public.v_job_cost_events
    WHERE source_id = '03000000-0000-4000-8000-000000000006' AND lane = 'other' AND lane_detail = 'other' AND is_actual AND amount_ex = 80;
  IF n <> 1 THEN RAISE EXCEPTION 'ZZTEST reimbursement cost row is wrong'; END IF;
  IF EXISTS (SELECT 1 FROM public.v_job_profit WHERE job_id = '03000000-0000-4000-8000-000000000001' AND cost_flag = 'unclassified_lines') THEN
    RAISE EXCEPTION 'ZZTEST reimbursement cost is unclassified';
  END IF;
END $$;
UPDATE public.trade_invoices SET status = 'ops-reject' WHERE id = '03000000-0000-4000-8000-000000000004';
INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,line_total_ex,expense_receipt_id) VALUES ('03000000-0000-4000-8000-000000000005','reimbursement',80,'03000000-0000-4000-8000-000000000003');
ROLLBACK;
