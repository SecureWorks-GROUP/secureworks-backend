BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.trade_invoice_lines'::regclass AND tgname='trade_invoice_lines_reimbursement_once') THEN
  RAISE EXCEPTION 'FU12 migration installed guard before director release';
 END IF;
END $$;
SELECT public.install_trade_invoice_reimbursement_guard();
-- Isolate historical business guards; keep receipt guard, unique index, and cascade.
DO $$ DECLARE t text; c record; BEGIN
 FOREACH t IN ARRAY ARRAY['users','jobs','trade_invoices','trade_invoice_lines','expense_receipts'] LOOP
  FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid = format('public.%I',t)::regclass AND NOT tgisinternal AND tgname <> 'trade_invoice_lines_reimbursement_once' LOOP
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,c.tgname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = format('public.%I',t)::regclass AND contype IN ('c','u','x') LOOP
   EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
  END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid = format('public.%I',t)::regclass AND attnum>0 AND NOT attisdropped AND attnotnull AND attname<>'id' LOOP
   EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL',t,c.attname);
  END LOOP;
 END LOOP;
END $$;
INSERT INTO public.users(id, org_id, name, role) VALUES
 ('12000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST trade','trade');
INSERT INTO public.jobs(id, org_id, job_number, type) VALUES
 ('12000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','ZZTEST-RECEIPT','fencing');
INSERT INTO public.expense_receipts(id) VALUES ('12000000-0000-4000-8000-000000000003');
UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_reimbursement_line_v1';
DO $$ DECLARE h jsonb; lines jsonb; first_id uuid; second_id uuid; submitted_id uuid; receipt_count int; reason text; BEGIN
 h := '{"org_id":"00000000-0000-0000-0000-000000000001","user_id":"12000000-0000-4000-8000-000000000001","week_start":"2026-11-16","week_end":"2026-11-22","status":"draft","invoice_source":"weekly_work_order","subtotal_ex":80,"gross_earned":80,"gst_on":false,"gst":0,"total_inc":80,"super_rate":0.12,"super_amount":0,"net_pay":80,"job_grand_total_ex":80,"final_deductions_total_ex":0,"to_be_paid_ex":80}';
 lines := '[{"line_type":"reimbursement","description":"ZZTEST receipt","expense_receipt_id":"12000000-0000-4000-8000-000000000003","quantity":1,"unit_rate":80,"line_total_ex":80}]';
 first_id := public.persist_weekly_trade_invoice_v1(h,lines,NULL);
 second_id := public.persist_weekly_trade_invoice_v1(h,lines,first_id);
 IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=first_id) THEN RAISE EXCEPTION 'FU12 first draft survived replacement'; END IF;
 -- A failure after releasing the prior claim must restore it and its header.
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h || '{"subtotal_ex":160,"gross_earned":160,"total_inc":160,"net_pay":160,"job_grand_total_ex":160,"to_be_paid_ex":160}',lines || lines,second_id);
  RAISE EXCEPTION 'FU12 expected duplicate receipt refusal';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=second_id AND expense_receipt_id='12000000-0000-4000-8000-000000000003') THEN RAISE EXCEPTION 'FU12 failed save lost prior receipt'; END IF;
 submitted_id := public.persist_weekly_trade_invoice_v1(h || '{"status":"pending_acknowledgment"}',lines,second_id);
 SELECT count(*) INTO receipt_count FROM public.trade_invoice_lines WHERE expense_receipt_id='12000000-0000-4000-8000-000000000003';
 IF receipt_count<>1 OR EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=second_id) OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=submitted_id AND status='pending_acknowledgment' AND gross_earned=80 AND net_pay=80) THEN RAISE EXCEPTION 'FU12 save twice then submit lost receipt or money'; END IF;
 UPDATE public.trade_invoices SET status='ops-reject' WHERE id=submitted_id;
 -- Retry without the claimed receipt is the API's path: week still saves.
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h,lines,NULL);
  RAISE EXCEPTION 'FU12 rejected receipt reclaimed';
 EXCEPTION WHEN unique_violation THEN
  IF SQLERRM <> 'reimbursement_already_claimed' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM public.trade_invoice_lines WHERE expense_receipt_id='12000000-0000-4000-8000-000000000003')<>1 THEN RAISE EXCEPTION 'FU12 reject then reclaim changed original'; END IF;
 -- The retry saves the unclaimed remainder with the rejected receipt left in place.
 second_id := public.persist_weekly_trade_invoice_v1(h || '{"invoice_source":"hourly","subtotal_ex":560,"gross_earned":560,"total_inc":560,"net_pay":500,"super_amount":60,"job_grand_total_ex":null,"final_deductions_total_ex":null,"to_be_paid_ex":null}',
   '[{"line_type":"labour","description":"ZZTEST remaining hours","line_total_ex":560}]',NULL);
 IF NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=second_id AND gross_earned=560 AND super_amount=60 AND net_pay=500) OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=submitted_id AND expense_receipt_id='12000000-0000-4000-8000-000000000003') THEN RAISE EXCEPTION 'FU12 reclaim lost remaining week or original claim'; END IF;
 DELETE FROM public.trade_invoices WHERE id=second_id;
 -- The permanent index also protects claims while the install-only guard is absent.
 ALTER TABLE public.trade_invoice_lines DISABLE TRIGGER trade_invoice_lines_reimbursement_once;
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h,lines,NULL);
  RAISE EXCEPTION 'FU12 unique index missing';
 EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS reason=CONSTRAINT_NAME;
  IF reason IS DISTINCT FROM 'trade_invoice_lines_one_receipt' THEN RAISE; END IF;
 END;
 ALTER TABLE public.trade_invoice_lines ENABLE TRIGGER trade_invoice_lines_reimbursement_once;
 DELETE FROM public.trade_invoices WHERE id=submitted_id;
 -- Dated hourly drafts use the same atomic replacement at submission.
 h := h || '{"invoice_source":"hourly","job_grand_total_ex":null,"final_deductions_total_ex":null,"to_be_paid_ex":null}';
 first_id := public.persist_weekly_trade_invoice_v1(h,lines,NULL);
 second_id := public.persist_weekly_trade_invoice_v1(h,lines,first_id);
 submitted_id := public.persist_weekly_trade_invoice_v1(h || '{"status":"pending_acknowledgment"}',lines,second_id);
 IF (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id=submitted_id AND expense_receipt_id='12000000-0000-4000-8000-000000000003')<>1 THEN RAISE EXCEPTION 'FU12 hourly submit lost receipt'; END IF;
 -- Switch off preserves the existing hourly draft route and rejects the added submit route.
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_reimbursement_line_v1';
 DELETE FROM public.trade_invoices WHERE id=submitted_id;
 first_id := public.persist_weekly_trade_invoice_v1(h,lines,NULL);
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h || '{"status":"pending_acknowledgment"}',lines,first_id);
  RAISE EXCEPTION 'FU12 hourly submit widened while off';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=first_id AND expense_receipt_id='12000000-0000-4000-8000-000000000003') THEN RAISE EXCEPTION 'FU12 refused submit changed draft'; END IF;
 DELETE FROM public.trade_invoices WHERE id=first_id;
 lines := '[{"line_type":"labour","description":"ZZTEST hours","line_total_ex":80}]';
 first_id := public.persist_weekly_trade_invoice_v1(h,lines,NULL);
 second_id := public.persist_weekly_trade_invoice_v1(h,lines,first_id);
 IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=first_id) OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=second_id AND line_total_ex=80 AND line_type='labour') THEN RAISE EXCEPTION 'FU12 off changed ordinary draft'; END IF;
END $$;
SELECT 'PASS: FU12 save twice then submit, reject then reclaim refusal, permanent index and hourly submission' AS result;
ROLLBACK;
