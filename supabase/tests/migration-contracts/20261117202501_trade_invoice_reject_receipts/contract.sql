BEGIN;
SET LOCAL statement_timeout = '30s';
-- Isolate the save/reject contract from unrelated historical business guards.
-- Keep the REAL group snapshot, receipt trigger, receipt checks and unique index.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['users','jobs','trade_invoices','trade_invoice_lines',
    'expense_receipts','group_work_orders','group_work_order_shares','job_client_signoffs'] LOOP
    FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid=format('public.%I',t)::regclass
      AND NOT tgisinternal AND tgname NOT IN
      ('trg_trade_invoice_lines_group_share_snapshot','trade_invoice_lines_reimbursement_once') LOOP
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,c.tgname);
    END LOOP;
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid=format('public.%I',t)::regclass
      AND contype IN ('c','u','x') AND conname NOT IN
      ('trade_invoice_lines_reimbursement_check','trade_invoice_lines_receipt_only_on_reimbursement',
       'trade_invoices_super_basis_check','trade_invoices_super_gst_split_check') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
    END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',t)::regclass
      AND attnum>0 AND NOT attisdropped AND attnotnull AND attname<>'id' LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL',t,c.attname);
    END LOOP;
  END LOOP;
END $$;
SELECT public.install_trade_invoice_reimbursement_guard();
INSERT INTO public.users(id,org_id,name,role) VALUES
 ('17000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST trade','trade');
INSERT INTO public.jobs(id,org_id,job_number,type) VALUES
 ('17000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','ZZTEST-HOURLY','fencing'),
 ('17000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000001','ZZTEST-GROUP','patio');
INSERT INTO public.expense_receipts(id) VALUES ('17000000-0000-4000-8000-000000000004');
-- A genuinely frozen, signed group. No group/pricing helper is stubbed.
INSERT INTO public.group_work_orders(id,org_id,job_id,status,pay_basis,split_frozen_at) VALUES
 ('17000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000001',
  '17000000-0000-4000-8000-000000000003','open','inclusive_12_112_v1',now());
INSERT INTO public.group_work_order_shares(id,group_id,user_id,share_ex) VALUES
 ('17000000-0000-4000-8000-000000000006','17000000-0000-4000-8000-000000000005',
  '17000000-0000-4000-8000-000000000001',280);
-- A signature-media FK, if present in the full stack, uses its genuine job media.
INSERT INTO public.job_media(id,job_id,phase,type,storage_url) VALUES
 ('17000000-0000-4000-8000-000000000007','17000000-0000-4000-8000-000000000003',
  'signature','photo','https://example.invalid/ZZTEST-signature.png');
INSERT INTO public.job_client_signoffs(job_id,method,happy,signature_media_id,created_at) VALUES
 ('17000000-0000-4000-8000-000000000003','share_link',true,
  '17000000-0000-4000-8000-000000000007',now()+interval '1 second');
UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_reimbursement_line_v1';
CREATE FUNCTION pg_temp.fu17_refuse_receipt_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'ZZTEST receipt release failed' USING ERRCODE='23514';
END $$;
DO $$ DECLARE h jsonb; lines jsonb; inv uuid; reclaimed uuid; result uuid;
BEGIN
 h := '{"org_id":"00000000-0000-0000-0000-000000000001","user_id":"17000000-0000-4000-8000-000000000001","week_start":"2026-11-16","week_end":"2026-11-22","status":"pending_acknowledgment","invoice_source":"hourly","subtotal_ex":920,"gross_earned":920,"gst_on":false,"gst":0,"total_inc":920,"super_rate":0.12,"super_amount":90,"net_pay":830,"super_basis":"inclusive_12_112_v1","super_base_ex":840,"total_hours":8}';
 -- No group_share_id in the input: the real insert trigger must bind it.
 lines := '[{"job_id":"17000000-0000-4000-8000-000000000002","line_type":"labour","line_total_ex":560,"total_hours":8},
  {"job_id":"17000000-0000-4000-8000-000000000003","line_type":"group share","line_total_ex":280},
  {"job_id":"17000000-0000-4000-8000-000000000002","line_type":"reimbursement","expense_receipt_id":"17000000-0000-4000-8000-000000000004","line_total_ex":80}]';
 inv := public.persist_weekly_trade_invoice_v1(h,lines,NULL);
 IF (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id=inv)<>3
    OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=inv
      AND line_type='group share' AND group_share_id='17000000-0000-4000-8000-000000000006' AND line_total_ex=280)
    OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=inv
      AND expense_receipt_id='17000000-0000-4000-8000-000000000004' AND line_total_ex=80)
    OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=inv AND status='pending_acknowledgment'
      AND gross_earned=920 AND super_base_ex=840 AND super_amount=90 AND net_pay=830 AND total_hours=8)
    OR (SELECT sum(line_total_ex) FROM public.trade_invoice_lines WHERE trade_invoice_id=inv)<>920 THEN
   RAISE EXCEPTION 'FU17 mixed hourly submit lost a line, group identity or receipt/super arithmetic';
 END IF;
 -- Switch-off RPC refuses before mutation. The API uses main's original update.
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_reimbursement_line_v1';
 BEGIN
  PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST off');
  RAISE EXCEPTION 'FU17 off rejected';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 IF NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=inv AND status='pending_acknowledgment')
    OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=inv AND expense_receipt_id IS NOT NULL) THEN
   RAISE EXCEPTION 'FU17 off changed an invoice';
 END IF;
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_reimbursement_line_v1';
 -- Xero custody and terminal lifecycle refuse, without freeing the claim.
 UPDATE public.trade_invoices SET xero_bill_id='ZZTEST-bill' WHERE id=inv;
 IF public.reject_trade_invoice_v1(inv,'ZZTEST no') IS NOT NULL THEN RAISE EXCEPTION 'FU17 rejected Xero custody'; END IF;
 UPDATE public.trade_invoices SET xero_bill_id=NULL,xero_pushed_at=now() WHERE id=inv;
 IF public.reject_trade_invoice_v1(inv,'ZZTEST no') IS NOT NULL THEN RAISE EXCEPTION 'FU17 rejected Xero stamp'; END IF;
 UPDATE public.trade_invoices SET xero_pushed_at=NULL,status='paid' WHERE id=inv;
 IF public.reject_trade_invoice_v1(inv,'ZZTEST no') IS NOT NULL THEN RAISE EXCEPTION 'FU17 rejected paid invoice'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=inv AND expense_receipt_id IS NOT NULL) THEN
   RAISE EXCEPTION 'FU17 refused rejection released a receipt';
 END IF;
 UPDATE public.trade_invoices SET status='pending_ops_review' WHERE id=inv;
 -- A storage failure cannot leave a rejected invoice that still owns its receipt.
 CREATE TRIGGER zztest_fu17_reject_failure BEFORE DELETE ON public.trade_invoice_lines
   FOR EACH ROW EXECUTE FUNCTION pg_temp.fu17_refuse_receipt_delete();
 BEGIN
  PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST must roll back');
  RAISE EXCEPTION 'FU17 expected receipt release failure';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM<>'ZZTEST receipt release failed' THEN RAISE; END IF;
 END;
 IF NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=inv AND status='pending_ops_review')
   OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=inv AND expense_receipt_id IS NOT NULL) THEN
  RAISE EXCEPTION 'FU17 receipt failure did not roll back rejection';
 END IF;
 DROP TRIGGER zztest_fu17_reject_failure ON public.trade_invoice_lines;
 result := public.reject_trade_invoice_v1(inv,'ZZTEST corrected week');
 IF result IS DISTINCT FROM inv OR NOT EXISTS (SELECT 1 FROM public.trade_invoices
   WHERE id=inv AND status='ops-reject' AND query_note='ZZTEST corrected week')
   OR (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id=inv)<>2
   OR EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=inv AND expense_receipt_id IS NOT NULL)
   OR NOT EXISTS (SELECT 1 FROM public.expense_receipts WHERE id='17000000-0000-4000-8000-000000000004') THEN
   RAISE EXCEPTION 'FU17 rejection did not release only its receipt claim';
 END IF;
 -- Replaying the old reject cannot free a receipt reclaimed on a newer invoice.
 reclaimed := public.persist_weekly_trade_invoice_v1(h,lines,NULL);
 PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST replay');
 IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=reclaimed
   AND expense_receipt_id='17000000-0000-4000-8000-000000000004') THEN
   RAISE EXCEPTION 'FU17 old rejection freed the corrected claim';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.trade_invoice_lines_one_receipt'::regclass AND indisunique)
    OR has_function_privilege('anon','public.reject_trade_invoice_v1(uuid,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.reject_trade_invoice_v1(uuid,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.reject_trade_invoice_v1(uuid,text)','EXECUTE') THEN
   RAISE EXCEPTION 'FU17 receipt uniqueness or operator-only RPC privileges changed';
 END IF;
END $$;
SELECT 'PASS: FU17 mixed hourly submit, exact group share, reject then reclaim, Xero refusal and switch-off' AS result;
ROLLBACK;
