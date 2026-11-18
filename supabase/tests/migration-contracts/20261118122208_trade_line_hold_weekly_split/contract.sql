-- P1-05.8 (Follow-up 34 item 4): the weekly persist accepts a held-line split
-- only when backed plus held rebuild each line exactly; without hold_lines it
-- behaves as main. Fixtures are rolled back.
-- Merge-safety rule 17: re-apply first (a no-op at this body), so an
-- earlier contract in the shard cannot leave a different body behind.
\ir ../../../migrations/20261118122208_trade_line_hold_weekly_split.sql
BEGIN;
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)
    IS DISTINCT FROM 'fe44f464f3c5c62b35149122f7655cb9' THEN
  RAISE EXCEPTION 'P1-05.8 weekly persist is not at this migration''s body';
 END IF;
END $$;
-- Isolate unrelated business guards, as the FU17 case does.
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
 ('c5800000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST trade','trade');
INSERT INTO public.jobs(id, org_id, job_number, type) VALUES
 ('c5800000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','ZZTEST-SPLIT','fencing');
INSERT INTO public.work_orders(id, org_id, job_id, status, completed_at, assigned_user_id, scope_items) VALUES
 ('c5800000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000001',
  'c5800000-0000-4000-8000-000000000002','complete','2026-11-17 02:00:00+00',
  'c5800000-0000-4000-8000-000000000001',
  '[{"description":"Fence install","quantity":10,"unit":"m","unit_price":30}]');
DO $$ DECLARE
 org text := '00000000-0000-0000-0000-000000000001';
 hh jsonb; wh jsonb; whole jsonb; backed jsonb; held jsonb; v uuid; n integer;
 bad text;
BEGIN
 -- 1. Hourly, no hold: as main. A whole 7.5 h line at 40 saves; a line whose
 --    quantity and rate miss its total is refused with main's words.
 hh := jsonb_build_object('org_id',org,'user_id','c5800000-0000-4000-8000-000000000001',
  'week_start','2026-11-16','week_end','2026-11-22','status','draft','invoice_source','hourly',
  'subtotal_ex',300,'gross_earned',300,'gst_on',false,'gst',0,'total_inc',300,
  'super_rate',0.12,'super_amount',0,'net_pay',300);
 whole := '[{"job_id":"c5800000-0000-4000-8000-000000000002","line_type":"labour","description":"ZZTEST fence","total_hours":7.5,"hourly_rate":40,"line_total_ex":300}]';
 v := public.persist_weekly_trade_invoice_v1(hh, whole, NULL);
 IF (SELECT sum(line_total_ex) FROM public.trade_invoice_lines WHERE trade_invoice_id=v) <> 300 THEN
  RAISE EXCEPTION 'P1-05.8 no-hold hourly save changed';
 END IF;
 DELETE FROM public.trade_invoices WHERE id=v;
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(hh,
   '[{"job_id":"c5800000-0000-4000-8000-000000000002","line_type":"labour","quantity":3,"unit_rate":100,"line_total_ex":300.01}]'::jsonb
   , NULL);
  RAISE EXCEPTION 'P1-05.8 expected main precision refusal';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM <> 'trade invoice line total does not match storage-precision quantity and rate' THEN RAISE; END IF;
 END;

 -- 2. Hourly with an exact same-rate split: 5 h backed, 2.5 h held. Only the
 --    backed part is saved; the header is the backed part.
 backed := '[{"job_id":"c5800000-0000-4000-8000-000000000002","line_type":"labour","description":"ZZTEST fence","total_hours":5,"hourly_rate":40,"line_total_ex":200,"split_group_id":"g1"}]';
 held := '[{"job_id":"c5800000-0000-4000-8000-000000000002","line_type":"labour","description":"ZZTEST fence (part over the job''s amount)","total_hours":2.5,"hourly_rate":40,"line_total_ex":100,"split_group_id":"g1","hold_reason":"over_amount"}]';
 v := public.persist_weekly_trade_invoice_v1(
  hh || '{"subtotal_ex":200,"gross_earned":200,"total_inc":200,"net_pay":200}'::jsonb || jsonb_build_object('hold_lines', held),
  backed, NULL);
 SELECT count(*) INTO n FROM public.trade_invoice_lines WHERE trade_invoice_id=v AND line_total_ex=200 AND total_hours=5;
 IF n <> 1 OR (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id=v) <> 1 THEN
  RAISE EXCEPTION 'P1-05.8 exact split did not save the backed part alone';
 END IF;
 DELETE FROM public.trade_invoices WHERE id=v;

 -- 3. A split that loses a cent, or adds one, is refused.
 FOREACH bad IN ARRAY ARRAY['99.99','100.01'] LOOP
  BEGIN
   PERFORM public.persist_weekly_trade_invoice_v1(
    hh || '{"subtotal_ex":200,"gross_earned":200,"total_inc":200,"net_pay":200}'::jsonb
       || jsonb_build_object('hold_lines', jsonb_set(held, '{0,line_total_ex}', to_jsonb(bad::numeric))),
    backed, NULL);
   RAISE EXCEPTION 'P1-05.8 expected a cent refusal for %', bad;
  EXCEPTION WHEN check_violation THEN
   IF SQLERRM <> 'a held-line split does not equal its quantity and rate to the cent' THEN RAISE; END IF;
  END;
 END LOOP;
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(
   hh || '{"subtotal_ex":200.01,"gross_earned":200.01,"total_inc":200.01,"net_pay":200.01}'::jsonb || jsonb_build_object('hold_lines', held),
   jsonb_set(backed, '{0,line_total_ex}', '200.01'), NULL);
  RAISE EXCEPTION 'P1-05.8 expected a backed cent refusal';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM <> 'a held-line split does not equal its quantity and rate to the cent' THEN RAISE; END IF;
 END;
 -- A part at another rate, or with another field changed, is refused.
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(
   hh || '{"subtotal_ex":200,"gross_earned":200,"total_inc":200,"net_pay":200}'::jsonb
      || jsonb_build_object('hold_lines', jsonb_set(jsonb_set(held, '{0,hourly_rate}', '41'), '{0,line_total_ex}', '102.5')),
   backed, NULL);
  RAISE EXCEPTION 'P1-05.8 expected a rate refusal';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM <> 'the two parts of a held-line split differ in more than quantity and amount' THEN RAISE; END IF;
 END;

 -- 4. Weekly work order, split by quantity: 6 m backed and 4 m held of a
 --    10 m scope line. Without hold_lines the backed part alone is a changed
 --    scope (main's refusal); with them the line is rebuilt and saves.
 wh := jsonb_build_object('org_id',org,'user_id','c5800000-0000-4000-8000-000000000001',
  'week_start','2026-11-16','week_end','2026-11-22','status','pending_acknowledgment',
  'invoice_source','weekly_work_order','subtotal_ex',180,'gross_earned',180,'gst_on',false,
  'gst',0,'total_inc',180,'super_rate',0.12,'super_amount',0,'net_pay',180,
  'job_grand_total_ex',180,'final_deductions_total_ex',0,'to_be_paid_ex',180);
 backed := '[{"job_id":"c5800000-0000-4000-8000-000000000002","source_work_order_id":"c5800000-0000-4000-8000-000000000003","line_type":"labour","description":"Fence install","quantity":6,"unit":"m","unit_rate":30,"line_total_ex":180,"line_date":"2026-11-17","split_group_id":"g2"}]';
 held := '[{"job_id":"c5800000-0000-4000-8000-000000000002","source_work_order_id":"c5800000-0000-4000-8000-000000000003","line_type":"labour","description":"Fence install (part over the job''s amount)","quantity":4,"unit":"m","unit_rate":30,"line_total_ex":120,"line_date":"2026-11-17","split_group_id":"g2","hold_reason":"over_amount"}]';
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(wh, backed, NULL);
  RAISE EXCEPTION 'P1-05.8 expected main scope refusal';
 EXCEPTION WHEN foreign_key_violation THEN
  IF SQLERRM <> 'weekly invoice source scope changed before persistence' THEN RAISE; END IF;
 END;
 v := public.persist_weekly_trade_invoice_v1(wh || jsonb_build_object('hold_lines', held), backed, NULL);
 IF (SELECT sum(line_total_ex) FROM public.trade_invoice_lines WHERE trade_invoice_id=v) <> 180 THEN
  RAISE EXCEPTION 'P1-05.8 weekly split saved more than its backed part';
 END IF;
 DELETE FROM public.trade_invoices WHERE id=v;
 -- The same split 1 cent short is refused.
 BEGIN
  PERFORM public.persist_weekly_trade_invoice_v1(
   wh || jsonb_build_object('hold_lines', jsonb_set(held, '{0,line_total_ex}', '119.99')), backed, NULL);
  RAISE EXCEPTION 'P1-05.8 expected weekly cent refusal';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- A whole held scope line, nothing backed but a second unchanged line,
 -- still rebuilds the scope.
 UPDATE public.work_orders SET scope_items =
  '[{"description":"Fence install","quantity":10,"unit":"m","unit_price":30},{"description":"Gate install","quantity":1,"unit":"ea","unit_price":50}]'
  WHERE id='c5800000-0000-4000-8000-000000000003';
 v := public.persist_weekly_trade_invoice_v1(
  wh || '{"subtotal_ex":50,"gross_earned":50,"total_inc":50,"net_pay":50,"job_grand_total_ex":50,"to_be_paid_ex":50}'::jsonb
     || jsonb_build_object('hold_lines', jsonb_set(jsonb_set(jsonb_set(jsonb_set(held, '{0,quantity}', '10'), '{0,line_total_ex}', '300'), '{0,description}', '"Fence install"'), '{0,split_group_id}', 'null')),
  '[{"job_id":"c5800000-0000-4000-8000-000000000002","source_work_order_id":"c5800000-0000-4000-8000-000000000003","line_type":"labour","description":"Gate install","quantity":1,"unit":"ea","unit_rate":50,"line_total_ex":50,"line_date":"2026-11-17"}]',
  NULL);
 IF (SELECT sum(line_total_ex) FROM public.trade_invoice_lines WHERE trade_invoice_id=v) <> 50 THEN
  RAISE EXCEPTION 'P1-05.8 whole held line was saved on the payable invoice';
 END IF;
END $$;
ROLLBACK;
SELECT 'P1-05.8 weekly persist split contract passed' AS result;
