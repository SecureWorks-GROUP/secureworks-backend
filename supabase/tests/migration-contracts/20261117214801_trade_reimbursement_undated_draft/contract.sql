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
DO $$ DECLARE h jsonb; lines jsonb; first_id uuid; second_id uuid; missing_key text; BEGIN
 h := '{"org_id":"00000000-0000-0000-0000-000000000001","user_id":"12000000-0000-4000-8000-000000000001","week_start":null,"week_end":null,"status":"draft","invoice_source":"hourly","subtotal_ex":80,"gross_earned":80,"gst_on":false,"gst":0,"total_inc":80,"super_rate":0.12,"super_amount":0,"net_pay":80}';
 lines := '[{"line_type":"reimbursement","description":"ZZTEST receipt","expense_receipt_id":"12000000-0000-4000-8000-000000000003","quantity":1,"unit_rate":80,"line_total_ex":80}]';
 first_id := public.persist_weekly_trade_invoice_v1(h,lines,NULL);
 second_id := public.persist_weekly_trade_invoice_v1(h,lines,first_id);
 IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=first_id)
 OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=second_id AND week_start IS NULL AND week_end IS NULL AND gross_earned=80 AND net_pay=80)
 OR (SELECT count(*) FROM public.trade_invoice_lines WHERE expense_receipt_id='12000000-0000-4000-8000-000000000003') <> 1
 OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=second_id AND expense_receipt_id='12000000-0000-4000-8000-000000000003')
 THEN RAISE EXCEPTION 'FU17 undated re-save lost its receipt or draft'; END IF;
 -- A failure after freeing the receipt rolls the entire replacement back.
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h || '{"subtotal_ex":160,"gross_earned":160,"total_inc":160,"net_pay":160}', lines || lines, second_id);
  RAISE EXCEPTION 'FU17 expected duplicate receipt refusal';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=second_id AND expense_receipt_id='12000000-0000-4000-8000-000000000003')
 THEN RAISE EXCEPTION 'FU17 failed save lost prior receipt'; END IF;
 -- A different or missing explicit prior id may not free this draft's receipt.
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h,lines,'12000000-0000-4000-8000-000000000099');
  RAISE EXCEPTION 'FU17 expected stale draft refusal';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'selected weekly/hourly draft is no longer replaceable' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h,lines,NULL);
  RAISE EXCEPTION 'FU17 expected another invoice claim refusal';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 -- Office changes are rechecked inside the transaction, after the API read.
 UPDATE public.trade_invoices SET status='ops-reject' WHERE id=second_id;
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h,lines,second_id);
  RAISE EXCEPTION 'FU17 expected office change refusal';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'selected weekly/hourly draft is no longer replaceable' THEN RAISE; END IF;
 END;
 UPDATE public.trade_invoices SET status='draft', xero_bill_id='ZZTEST-bill' WHERE id=second_id;
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h,lines,second_id);
  RAISE EXCEPTION 'FU17 expected Xero identity refusal';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'weekly/hourly draft has an external Xero identity' THEN RAISE; END IF;
 END;
 UPDATE public.trade_invoices SET xero_bill_id=NULL WHERE id=second_id;
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h || '{"user_id":"12000000-0000-4000-8000-000000000099"}',lines,second_id);
  RAISE EXCEPTION 'FU17 expected different owner refusal';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h || '{"week_end":"2026-11-22"}',lines,second_id);
  RAISE EXCEPTION 'FU17 expected half dated refusal';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 -- Missing identity must refuse rather than let a NULL predicate pass.
 FOREACH missing_key IN ARRAY ARRAY['invoice_source','status'] LOOP
  BEGIN
   PERFORM public.persist_weekly_trade_invoice_v1(h - missing_key,lines,second_id);
   RAISE EXCEPTION 'FU17 expected missing identity refusal';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 END LOOP;
 -- Refusal is retryable once the record is replaceable again.
 first_id := public.persist_weekly_trade_invoice_v1(h,lines,second_id);
 IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=second_id)
 OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=first_id AND expense_receipt_id='12000000-0000-4000-8000-000000000003')
 THEN RAISE EXCEPTION 'FU17 retry lost receipt'; END IF;
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_reimbursement_line_v1';
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(h,lines,first_id);
  RAISE EXCEPTION 'FU17 expected switch off identity refusal';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=first_id AND expense_receipt_id='12000000-0000-4000-8000-000000000003')
 THEN RAISE EXCEPTION 'FU17 off refusal lost prior receipt'; END IF;
END $$;
-- Prove the new reads use bounded index scans, independent of the index name.
INSERT INTO public.trade_invoices(id)
SELECT md5('ZZTEST-plan-' || n)::uuid FROM generate_series(1,4000) AS n;
UPDATE public.trade_invoices
SET org_id='00000000-0000-0000-0000-000000000001',
 user_id='12000000-0000-4000-8000-000000000001', status='draft', invoice_source='hourly'
WHERE id=md5('ZZTEST-plan-2000')::uuid;
ANALYZE public.trade_invoices;
DO $$ DECLARE query text; plan jsonb; reads integer; BEGIN
 FOREACH query IN ARRAY ARRAY[
  $q$SELECT id, org_id, user_id, status, invoice_source, week_start, week_end,
   xero_bill_id, xero_pushed_at, gross_earned, super_basis, super_base_ex
   FROM public.trade_invoices WHERE id=md5('ZZTEST-plan-2000')::uuid$q$,
  $q$SELECT id, xero_bill_id, xero_pushed_at FROM public.trade_invoices
   WHERE id=md5('ZZTEST-plan-2000')::uuid
    AND org_id='00000000-0000-0000-0000-000000000001'
    AND user_id='12000000-0000-4000-8000-000000000001'
    AND week_start IS NULL AND week_end IS NULL
    AND invoice_source='hourly' AND status='draft' FOR UPDATE$q$
 ] LOOP
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || query INTO plan;
  WITH RECURSIVE nodes(n) AS (
   SELECT plan->0->'Plan'
   UNION ALL
   SELECT child FROM nodes CROSS JOIN LATERAL
    jsonb_array_elements(COALESCE(n->'Plans','[]'::jsonb)) AS child
  )
  SELECT count(*) FILTER (WHERE n->>'Relation Name'='trade_invoices'
    AND n->>'Node Type' IN ('Index Scan','Index Only Scan')
    AND (n->>'Actual Rows')::numeric=1
    AND COALESCE((n->>'Rows Removed by Filter')::numeric,0)=0)
   INTO reads FROM nodes;
  IF reads<>1 OR plan::text LIKE '%"Seq Scan"%' THEN
   RAISE EXCEPTION 'FU17 draft lookup is not one bounded index read: %',plan;
  END IF;
 END LOOP;
END $$;
SELECT 'PASS: FU17 undated draft saved twice keeps exactly one receipt' AS result;
ROLLBACK;
