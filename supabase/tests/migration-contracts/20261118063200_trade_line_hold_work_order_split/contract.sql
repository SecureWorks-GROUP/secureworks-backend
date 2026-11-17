-- P1-05.8 (director ruling 3): the work-order door accepts a held-line split
-- only when backed plus held rebuild each line exactly, may save deductions
-- alone when all its work is held, and behaves as main without hold_lines.
-- Fixtures are rolled back.
BEGIN;
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)
    IS DISTINCT FROM '87f0d8ce6b3e090105b011e8962017ea' THEN
  RAISE EXCEPTION 'P1-05.8 work-order persist is not at this migration''s body';
 END IF;
END $$;
DO $$ DECLARE t text; c record; BEGIN
 FOREACH t IN ARRAY ARRAY['users','jobs','work_orders','trade_invoices','trade_invoice_lines'] LOOP
  FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid = format('public.%I',t)::regclass AND NOT tgisinternal LOOP
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
 ('c5900000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST trade','trade'),
 ('c5900000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000001','ZZTEST crew','trade');
INSERT INTO public.jobs(id, org_id, job_number, type) VALUES
 ('c5900000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','ZZTEST-WO','fencing');
INSERT INTO public.work_orders(id, org_id, job_id, status, completed_at, assigned_user_id, scope_items) VALUES
 ('c5900000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000001',
  'c5900000-0000-4000-8000-000000000002','complete','2026-11-17 02:00:00+00',
  'c5900000-0000-4000-8000-000000000001',
  '[{"description":"Fence install","quantity":10,"unit":"m","unit_price":30}]');
-- A crew charge from another trade, acknowledged, on a live invoice.
INSERT INTO public.trade_invoices(id, org_id, user_id, status) VALUES
 ('c5900000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000001',
  'c5900000-0000-4000-8000-000000000004','pending_acknowledgment');
INSERT INTO public.trade_invoice_lines(id, trade_invoice_id, job_id, line_type, line_total_ex, acknowledgment_status) VALUES
 ('c5900000-0000-4000-8000-000000000006','c5900000-0000-4000-8000-000000000005',
  'c5900000-0000-4000-8000-000000000002','labour',25,'acknowledged');
DO $$ DECLARE
 h jsonb; line jsonb; backed jsonb; held jsonb; ded jsonb; v uuid;
BEGIN
 h := '{"org_id":"00000000-0000-0000-0000-000000000001","user_id":"c5900000-0000-4000-8000-000000000001","work_order_id":"c5900000-0000-4000-8000-000000000003","job_id":"c5900000-0000-4000-8000-000000000002","invoice_source":"work_order","status":"draft","source_work_order_date":"2026-11-17","subtotal_ex":300,"gross_earned":300,"gst":0,"total_inc":300,"gst_on":false,"super_rate":0.12,"super_amount":0,"net_pay":300}';
 line := '{"job_id":"c5900000-0000-4000-8000-000000000002","description":"Fence install","quantity":10,"unit":"m","unit_rate":30,"line_total_ex":300,"line_date":"2026-11-17"}';
 -- 1. No hold: as main.
 v := public.persist_trade_work_order_invoice_v1(h, jsonb_build_array(line), NULL);
 IF (SELECT sum(line_total_ex) FROM public.trade_invoice_lines WHERE trade_invoice_id=v) <> 300 THEN
  RAISE EXCEPTION 'P1-05.8 no-hold work-order save changed';
 END IF;
 DELETE FROM public.trade_invoices WHERE id=v;
 -- 2. Exact split, 6 m backed and 4 m held.
 backed := jsonb_build_array(line || '{"quantity":6,"line_total_ex":180,"split_group_id":"g1"}');
 held := jsonb_build_array(line || '{"quantity":4,"line_total_ex":120,"split_group_id":"g1","hold_reason":"over_amount","description":"Fence install (part over the job''s amount)"}');
 BEGIN
  PERFORM public.persist_trade_work_order_invoice_v1(h || '{"subtotal_ex":180,"gross_earned":180,"total_inc":180,"net_pay":180}', backed, NULL);
  RAISE EXCEPTION 'P1-05.8 expected main scope refusal';
 EXCEPTION WHEN foreign_key_violation THEN
  IF SQLERRM <> 'work-order invoice source scope changed before persistence' THEN RAISE; END IF;
 END;
 v := public.persist_trade_work_order_invoice_v1(
  h || '{"subtotal_ex":180,"gross_earned":180,"total_inc":180,"net_pay":180}'::jsonb || jsonb_build_object('hold_lines', held),
  backed, NULL);
 IF (SELECT sum(line_total_ex) FROM public.trade_invoice_lines WHERE trade_invoice_id=v) <> 180 THEN
  RAISE EXCEPTION 'P1-05.8 work-order split saved more than its backed part';
 END IF;
 DELETE FROM public.trade_invoices WHERE id=v;
 -- 3. A split that loses or adds a cent is refused.
 BEGIN
  PERFORM public.persist_trade_work_order_invoice_v1(
   h || '{"subtotal_ex":180,"gross_earned":180,"total_inc":180,"net_pay":180}'::jsonb
     || jsonb_build_object('hold_lines', jsonb_set(held, '{0,line_total_ex}', '119.99')),
   backed, NULL);
  RAISE EXCEPTION 'P1-05.8 expected a cent refusal';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM <> 'a held-line split does not equal its quantity and rate to the cent' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM public.persist_trade_work_order_invoice_v1(
   h || '{"subtotal_ex":180.01,"gross_earned":180.01,"total_inc":180.01,"net_pay":180.01}'::jsonb || jsonb_build_object('hold_lines', held),
   jsonb_set(backed, '{0,line_total_ex}', '180.01'), NULL);
  RAISE EXCEPTION 'P1-05.8 expected an added cent refusal';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- 4. All the work held, a crew charge kept: the deduction saves alone.
 ded := '[{"job_id":"c5900000-0000-4000-8000-000000000002","line_type":"crew_work_order_deduction","description":"Less: crew charge","quantity":1,"unit":"ea","unit_rate":-25,"line_total_ex":-25,"line_date":"2026-11-17","source_trade_invoice_line_id":"c5900000-0000-4000-8000-000000000006"}]';
 BEGIN
  PERFORM public.persist_trade_work_order_invoice_v1(
   h || '{"subtotal_ex":-25,"gross_earned":-25,"total_inc":-25,"net_pay":-25}', ded, NULL);
  RAISE EXCEPTION 'P1-05.8 expected main refusal of a deduction-only invoice';
 EXCEPTION WHEN foreign_key_violation THEN
  IF SQLERRM <> 'work-order invoice source scope changed before persistence' THEN RAISE; END IF;
 END;
 v := public.persist_trade_work_order_invoice_v1(
  h || '{"subtotal_ex":-25,"gross_earned":-25,"total_inc":-25,"net_pay":-25}'::jsonb
    || jsonb_build_object('hold_lines', jsonb_build_array(line || '{"hold_reason":"no_work_order"}')),
  ded, NULL);
 IF (SELECT sum(line_total_ex) FROM public.trade_invoice_lines WHERE trade_invoice_id=v) <> -25 THEN
  RAISE EXCEPTION 'P1-05.8 deduction-only save lost its deduction';
 END IF;
 DELETE FROM public.trade_invoices WHERE id=v;
 -- A backed line below its deductions is not a deduction-only save: refused as main.
 BEGIN
  PERFORM public.persist_trade_work_order_invoice_v1(
   h || '{"subtotal_ex":-25,"gross_earned":-25,"total_inc":-25,"net_pay":-25}'::jsonb
     || jsonb_build_object('hold_lines', jsonb_build_array(line || '{"hold_reason":"no_work_order"}')),
   ded || jsonb_build_array(line || '{"quantity":0,"line_total_ex":0}'), NULL);
  RAISE EXCEPTION 'P1-05.8 expected a mixed non-positive refusal';
 EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE NOT IN ('23514','23503') THEN RAISE; END IF;
 END;
END $$;
ROLLBACK;
SELECT 'P1-05.8 work-order persist split contract passed' AS result;
