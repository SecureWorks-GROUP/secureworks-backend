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
   RAISE EXCEPTION 'FU22 receipt read did not use an index: %',p;
 END IF;
 RAISE NOTICE 'FU22 receipt read plan: %',p;
 EXECUTE $query$EXPLAIN (FORMAT JSON) DELETE FROM public.trade_invoice_lines
   WHERE id='22000000-0000-4000-8000-000000000007'$query$ INTO p;
 IF p::text LIKE '%Seq Scan%' OR p::text NOT LIKE '%Index Scan%' THEN
   RAISE EXCEPTION 'FU22 exact delete did not use an index: %',p;
 END IF;
 RAISE NOTICE 'FU22 exact delete plan: %',p;
END $plan$;

-- Observe the real deletion: its exact claim must already be durable in this transaction.
CREATE FUNCTION pg_temp.fu22_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.expense_receipt_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM public.trade_invoice_events e WHERE e.trade_invoice_id=OLD.trade_invoice_id
     AND e.event_type='receipt_released' AND e.detail=to_jsonb(OLD)) THEN
   RAISE EXCEPTION 'FU22 release deleted a claim before its event';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER zztest_fu22_before_delete BEFORE DELETE ON public.trade_invoice_lines
 FOR EACH ROW EXECUTE FUNCTION pg_temp.fu22_before_delete();
CREATE FUNCTION pg_temp.fu22_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.event_type='receipt_released' AND NEW.detail->>'id'='22000000-0000-4000-8000-000000000008' THEN
   RAISE EXCEPTION 'ZZTEST event unavailable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION pg_temp.fu22_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'ZZTEST delete unavailable' USING ERRCODE='23514';
END $$;
DO $$ DECLARE inv uuid := '22000000-0000-4000-8000-000000000005'; expected jsonb; result uuid; BEGIN
 -- Missing and disabled switches retain main's no-write refusal.
 DELETE FROM public.feature_flags WHERE flag_name='trade_reimbursement_line_v1';
 BEGIN
   PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST missing switch');
   RAISE EXCEPTION 'FU22 missing switch allowed rejection';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 INSERT INTO public.feature_flags(flag_name,enabled) VALUES ('trade_reimbursement_line_v1',false);
 BEGIN
   PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST disabled');
   RAISE EXCEPTION 'FU22 disabled switch allowed rejection';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 IF EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE trade_invoice_id=inv)
    OR (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id=inv)<>3
    OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=inv AND query_note='ZZTEST original' AND status='pending_ops_review') THEN
   RAISE EXCEPTION 'FU22 switch off changed main behaviour';
 END IF;
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_reimbursement_line_v1';
 IF public.reject_trade_invoice_v1('22000000-0000-4000-8000-000000000099','ZZTEST missing') IS NOT NULL
    OR public.reject_trade_invoice_v1(NULL,'ZZTEST missing') IS NOT NULL THEN
   RAISE EXCEPTION 'FU22 missing invoice changed main refusal';
 END IF;
 -- An unreadable switch raises before mutation, as main does. No release is invented.
 REVOKE SELECT ON public.feature_flags FROM service_role;
 BEGIN
   SET LOCAL ROLE service_role;
   PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST unreadable switch');
   RESET ROLE;
   RAISE EXCEPTION 'FU22 unreadable switch allowed rejection';
 EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; END;
 IF EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE trade_invoice_id=inv)
    OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=inv AND status='pending_ops_review') THEN
   RAISE EXCEPTION 'FU22 unreadable switch changed invoice';
 END IF;
 -- Office/Xero edits still refuse at the original conditional update.
 UPDATE public.trade_invoices SET xero_bill_id='ZZTEST-bill' WHERE id=inv;
 IF public.reject_trade_invoice_v1(inv,'ZZTEST refused') IS NOT NULL THEN RAISE EXCEPTION 'FU22 changed Xero custody refusal'; END IF;
 UPDATE public.trade_invoices SET xero_bill_id=NULL,xero_pushed_at=now() WHERE id=inv;
 IF public.reject_trade_invoice_v1(inv,'ZZTEST refused') IS NOT NULL THEN RAISE EXCEPTION 'FU22 changed Xero stamp refusal'; END IF;
 UPDATE public.trade_invoices SET xero_pushed_at=NULL,status='paid' WHERE id=inv;
 IF public.reject_trade_invoice_v1(inv,'ZZTEST refused') IS NOT NULL THEN RAISE EXCEPTION 'FU22 changed paid refusal'; END IF;
 IF EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE trade_invoice_id=inv) THEN RAISE EXCEPTION 'FU22 refusal wrote release event'; END IF;
 UPDATE public.trade_invoices SET status='pending_ops_review' WHERE id=inv;
 -- Office changes are snapshotted as they stand now, never from an earlier read.
 UPDATE public.trade_invoice_lines SET line_total_ex=32.50,description='ZZTEST office corrected claim'
   WHERE id='22000000-0000-4000-8000-000000000007';
 SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) INTO expected FROM public.trade_invoice_lines l
   WHERE l.trade_invoice_id=inv AND l.expense_receipt_id IS NOT NULL;
 -- A failed event after the first release must roll back BOTH lines, events and header.
 CREATE TRIGGER zztest_fu22_event_failure BEFORE INSERT ON public.trade_invoice_events
   FOR EACH ROW EXECUTE FUNCTION pg_temp.fu22_event_failure();
 BEGIN
   PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST failed event');
   RAISE EXCEPTION 'FU22 expected event failure';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'ZZTEST event unavailable' THEN RAISE; END IF; END;
 DROP TRIGGER zztest_fu22_event_failure ON public.trade_invoice_events;
 IF EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE trade_invoice_id=inv)
    OR (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.trade_invoice_lines l
       WHERE l.trade_invoice_id=inv AND l.expense_receipt_id IS NOT NULL) IS DISTINCT FROM expected
    OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=inv AND status='pending_ops_review' AND query_note='ZZTEST original') THEN
   RAISE EXCEPTION 'FU22 event failure lost original claim';
 END IF;
 -- A failed delete also rolls back its preceding event and the rejection.
 CREATE TRIGGER zztest_fu22_delete_failure BEFORE DELETE ON public.trade_invoice_lines
   FOR EACH ROW EXECUTE FUNCTION pg_temp.fu22_delete_failure();
 BEGIN
   PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST failed delete');
   RAISE EXCEPTION 'FU22 expected delete failure';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'ZZTEST delete unavailable' THEN RAISE; END IF; END;
 DROP TRIGGER zztest_fu22_delete_failure ON public.trade_invoice_lines;
 IF EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE trade_invoice_id=inv)
    OR (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id=inv)<>3
    OR NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=inv AND status='pending_ops_review') THEN
   RAISE EXCEPTION 'FU22 delete failure left an event or rejection';
 END IF;
 -- Retry succeeds: one exact event per released claim, with no labour or receipt deletion.
 result := public.reject_trade_invoice_v1(inv,'ZZTEST reject');
 IF result IS DISTINCT FROM inv
    OR (SELECT jsonb_agg(e.detail ORDER BY e.detail->>'id') FROM public.trade_invoice_events e
       WHERE e.trade_invoice_id=inv AND e.event_type='receipt_released') IS DISTINCT FROM expected
    OR (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id=inv)<>1
    OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=inv AND line_type='labour' AND line_total_ex=100)
    OR (SELECT count(*) FROM public.expense_receipts WHERE id IN ('22000000-0000-4000-8000-000000000003','22000000-0000-4000-8000-000000000004'))<>2 THEN
   RAISE EXCEPTION 'FU22 retry did not retain exact released claims';
 END IF;
 -- The receipt can be claimed again; replaying the old reject releases nothing twice.
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,line_total_ex,expense_receipt_id)
 VALUES ('22000000-0000-4000-8000-000000000006','reimbursement',32.50,'22000000-0000-4000-8000-000000000003');
 PERFORM public.reject_trade_invoice_v1(inv,'ZZTEST replay');
 IF (SELECT count(*) FROM public.trade_invoice_events WHERE trade_invoice_id=inv)<>2
    OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines
      WHERE trade_invoice_id='22000000-0000-4000-8000-000000000006' AND expense_receipt_id='22000000-0000-4000-8000-000000000003') THEN
   RAISE EXCEPTION 'FU22 replay duplicated an event or freed a new claim';
 END IF;
 -- The existing append-only protection applies to the new event too.
 BEGIN
   UPDATE public.trade_invoice_events SET reason='ZZTEST overwrite' WHERE trade_invoice_id=inv;
   RAISE EXCEPTION 'FU22 release event was mutable';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
-- Re-apply is safe over its own body and retained receipt events.
\ir ../../../migrations/20261117220101_trade_invoice_receipt_release_event.sql
SELECT 'PASS: FU22 before-delete claim snapshot, missing/off refusal, office edits, event/delete rollback, retry and reclaim' AS result;
ROLLBACK;
