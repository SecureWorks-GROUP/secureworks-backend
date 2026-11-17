BEGIN;
SET LOCAL statement_timeout = '30s';
\ir ../../../migrations/20261117220101_trade_invoice_receipt_release_event.sql
\ir ../../../migrations/20261117235501_trade_invoice_receipt_release_actor.sql
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
-- Use the real reject function, event table, append-only guard and receipt index.
INSERT INTO public.users(id,org_id,name,role) VALUES
 ('22000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST trade','trade');
INSERT INTO public.jobs(id,org_id,job_number,type) VALUES
 ('22000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','ZZTEST-RECEIPT','fencing');
INSERT INTO public.expense_receipts(id) VALUES
 ('22000000-0000-4000-8000-000000000003'),('22000000-0000-4000-8000-000000000004');
INSERT INTO public.trade_invoices(id,user_id,status,query_note) VALUES
 ('22000000-0000-4000-8000-000000000005','22000000-0000-4000-8000-000000000001','pending_ops_review','ZZTEST original'),
 ('22000000-0000-4000-8000-000000000006','22000000-0000-4000-8000-000000000001','draft',NULL);
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,job_id,line_type,line_total_ex,expense_receipt_id) VALUES
 ('22000000-0000-4000-8000-000000000007','22000000-0000-4000-8000-000000000005','22000000-0000-4000-8000-000000000002','reimbursement',31.25,'22000000-0000-4000-8000-000000000003'),
 ('22000000-0000-4000-8000-000000000008','22000000-0000-4000-8000-000000000005','22000000-0000-4000-8000-000000000002','reimbursement',18.75,'22000000-0000-4000-8000-000000000004'),
 ('22000000-0000-4000-8000-000000000009','22000000-0000-4000-8000-000000000005','22000000-0000-4000-8000-000000000002','labour',100,NULL);

-- A selective invoice in a larger line table, with the historical baseline index.
INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,line_total_ex)
 SELECT '22000000-0000-4000-8000-000000000006','labour',1 FROM generate_series(1,2000);
ANALYZE public.trade_invoice_lines;
DO $plan$ DECLARE p jsonb; BEGIN
 EXECUTE $query$EXPLAIN (ANALYZE,FORMAT JSON) SELECT l.* FROM public.trade_invoice_lines l
   WHERE l.trade_invoice_id='22000000-0000-4000-8000-000000000005' AND l.expense_receipt_id IS NOT NULL
   ORDER BY l.id FOR UPDATE$query$ INTO p;
 IF p::text LIKE '%Seq Scan%' OR p::text NOT LIKE '%Index Scan%' THEN
   RAISE EXCEPTION 'cx-reimb-rest receipt read did not use an index: %',p;
 END IF;
 RAISE NOTICE 'cx-reimb-rest receipt read plan: %',p;
 EXECUTE $query$EXPLAIN (FORMAT JSON) DELETE FROM public.trade_invoice_lines
   WHERE id='22000000-0000-4000-8000-000000000007'$query$ INTO p;
 IF p::text LIKE '%Seq Scan%' OR p::text NOT LIKE '%Index Scan%' THEN
   RAISE EXCEPTION 'cx-reimb-rest exact delete did not use an index: %',p;
 END IF;
 RAISE NOTICE 'cx-reimb-rest exact delete plan: %',p;
END $plan$;

-- A real event failure must restore the header, receipts and audit together.
CREATE FUNCTION pg_temp.reimb_rest_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.event_type='receipt_released' THEN
    RAISE EXCEPTION 'ZZTEST event unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE inv uuid := '22000000-0000-4000-8000-000000000005'; expected jsonb; result uuid; BEGIN
  INSERT INTO public.feature_flags(flag_name,enabled) VALUES ('trade_reimbursement_line_v1',true)
    ON CONFLICT (flag_name) DO UPDATE SET enabled=true;
    BEGIN
      PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST no actor',NULL);
      RAISE EXCEPTION 'cx-reimb-rest accepted absent actor';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
    BEGIN
      PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST no actor','  ');
      RAISE EXCEPTION 'cx-reimb-rest accepted blank actor';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  IF EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE trade_invoice_id=inv)
     OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=inv AND status='pending_ops_review') THEN
    RAISE EXCEPTION 'cx-reimb-rest absent actor changed invoice';
  END IF;
  UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_reimbursement_line_v1';
  BEGIN
    PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST off','user:ZZTEST-office');
    RAISE EXCEPTION 'cx-reimb-rest allowed switch off';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
  UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_reimbursement_line_v1';
  -- Missing invoice and office/Xero edits retain the prior refusal.
  IF public.reject_trade_invoice_v1(NULL,'ZZTEST missing','user:ZZTEST-office') IS NOT NULL THEN
    RAISE EXCEPTION 'cx-reimb-rest invented missing invoice';
  END IF;
  UPDATE public.trade_invoices SET xero_bill_id='ZZTEST-bill' WHERE id=inv;
  IF public.reject_trade_invoice_v1(inv,'ZZTEST edited','user:ZZTEST-office') IS NOT NULL THEN
    RAISE EXCEPTION 'cx-reimb-rest ignored office Xero edit';
  END IF;
  UPDATE public.trade_invoices SET xero_bill_id=NULL WHERE id=inv;
  UPDATE public.trade_invoice_lines SET description='ZZTEST office corrected claim',line_total_ex=1
    WHERE id='22000000-0000-4000-8000-000000000007';
  SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) INTO expected FROM public.trade_invoice_lines l
    WHERE l.trade_invoice_id=inv AND l.expense_receipt_id IS NOT NULL;
  CREATE TRIGGER zztest_reimb_rest_event_failure BEFORE INSERT ON public.trade_invoice_events
    FOR EACH ROW EXECUTE FUNCTION pg_temp.reimb_rest_event_failure();
  BEGIN
    PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST failed event','user:ZZTEST-office');
    RAISE EXCEPTION 'cx-reimb-rest ignored event failure';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'ZZTEST event unavailable' THEN RAISE; END IF;
  END;
  DROP TRIGGER zztest_reimb_rest_event_failure ON public.trade_invoice_events;
  IF EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE trade_invoice_id=inv)
     OR (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id=inv)<>3
     OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=inv AND status='pending_ops_review') THEN
    RAISE EXCEPTION 'cx-reimb-rest failed event left a partial release';
  END IF;
  result := public.reject_trade_invoice_v1(inv,'ZZTEST retry','user:ZZTEST-office');
  IF result IS DISTINCT FROM inv
     OR (SELECT jsonb_agg(e.detail ORDER BY e.detail->>'id') FROM public.trade_invoice_events e
         WHERE e.trade_invoice_id=inv AND e.event_type='receipt_released') IS DISTINCT FROM expected
     OR EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE trade_invoice_id=inv AND actor<>'user:ZZTEST-office')
     OR (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id=inv)<>1 THEN
    RAISE EXCEPTION 'cx-reimb-rest release lost actor, exact claim or labour';
  END IF;
  PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST replay','user:ZZTEST-other-office');
  IF (SELECT count(*) FROM public.trade_invoice_events WHERE trade_invoice_id=inv)<>2
     OR EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE trade_invoice_id=inv AND actor<>'user:ZZTEST-office') THEN
    RAISE EXCEPTION 'cx-reimb-rest replay duplicated or rewrote actor';
  END IF;
  IF has_function_privilege('anon','public.reject_trade_invoice_v1(uuid,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.reject_trade_invoice_v1(uuid,text,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.reject_trade_invoice_v1(uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'cx-reimb-rest RPC role boundary changed';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reject_trade_invoice_v1(uuid,text)'::regprocedure)
     <> '7f9368d57bed7d02e0a918fd20867680' THEN
    RAISE EXCEPTION 'cx-reimb-rest changed original two-argument body';
  END IF;
END $$;
\ir ../../../migrations/20261117235501_trade_invoice_receipt_release_actor.sql
SELECT 'PASS: cx-reimb-rest actor, current office edits, missing/off refusal, atomic failed event, retry, replay, permissions and original body' AS result;
ROLLBACK;
