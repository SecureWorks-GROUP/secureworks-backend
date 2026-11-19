BEGIN;
SET LOCAL statement_timeout = '30s';
-- Isolate the reject from unrelated historical business guards. Keep the real
-- reject function, receipt trigger and event table.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['users','jobs','trade_invoices','trade_invoice_lines','expense_receipts'] LOOP
    FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid=format('public.%I',t)::regclass
      AND NOT tgisinternal AND tgname <> 'trade_invoice_lines_reimbursement_once' LOOP
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,c.tgname);
    END LOOP;
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid=format('public.%I',t)::regclass
      AND contype IN ('c','u','x','f') AND conname NOT IN
      ('trade_invoice_lines_reimbursement_check','trade_invoice_lines_receipt_only_on_reimbursement') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
    END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',t)::regclass
      AND attnum>0 AND NOT attisdropped AND attnotnull AND attname<>'id' LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL',t,c.attname);
    END LOOP;
  END LOOP;
END $$;
INSERT INTO public.expense_receipts(id) VALUES
 ('23000000-0000-4000-8000-000000000003'),('23000000-0000-4000-8000-000000000004');
-- Made-up amounts. 05 is in an approved pay run; 06 is in none.
INSERT INTO public.trade_invoices(id,status,query_note,pay_run_id) VALUES
 ('23000000-0000-4000-8000-000000000005','pending_ops_review','ZZTEST original','23000000-0000-4000-8000-000000000001'),
 ('23000000-0000-4000-8000-000000000006','pending_ops_review','ZZTEST original',NULL);
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,line_type,line_total_ex,expense_receipt_id) VALUES
 ('23000000-0000-4000-8000-000000000007','23000000-0000-4000-8000-000000000005','reimbursement',12.5,'23000000-0000-4000-8000-000000000003'),
 ('23000000-0000-4000-8000-000000000008','23000000-0000-4000-8000-000000000006','reimbursement',7.5,'23000000-0000-4000-8000-000000000004'),
 ('23000000-0000-4000-8000-000000000009','23000000-0000-4000-8000-000000000006','labour',100,NULL);
INSERT INTO public.feature_flags(flag_name,enabled) VALUES ('trade_reimbursement_line_v1',true)
  ON CONFLICT (flag_name) DO UPDATE SET enabled=true;

DO $$ DECLARE held uuid := '23000000-0000-4000-8000-000000000005';
  free uuid := '23000000-0000-4000-8000-000000000006'; before jsonb; BEGIN
  SELECT to_jsonb(i) INTO before FROM public.trade_invoices i WHERE id=held;
  -- An invoice a pay run approved is refused: NULL, nothing written, no receipt released.
  IF public.reject_trade_invoice_v1(held,'ZZTEST sent back','user:ZZTEST-office') IS NOT NULL THEN
    RAISE EXCEPTION 'reject_pay_run_held_invoice_rejected';
  END IF;
  IF (SELECT to_jsonb(i) FROM public.trade_invoices i WHERE id=held) IS DISTINCT FROM before
     OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE id='23000000-0000-4000-8000-000000000007')
     OR EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE trade_invoice_id=held) THEN
    RAISE EXCEPTION 'reject_pay_run_held_invoice_changed';
  END IF;
  -- Every other reject behaviour is as before.
  BEGIN
    PERFORM public.reject_trade_invoice_v1(free,'ZZTEST no actor','  ');
    RAISE EXCEPTION 'reject_pay_run_blank_actor_accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_reimbursement_line_v1';
  BEGIN
    PERFORM public.reject_trade_invoice_v1(free,'ZZTEST off','user:ZZTEST-office');
    RAISE EXCEPTION 'reject_pay_run_switch_off_allowed';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
  UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_reimbursement_line_v1';
  IF public.reject_trade_invoice_v1(NULL,'ZZTEST missing','user:ZZTEST-office') IS NOT NULL THEN
    RAISE EXCEPTION 'reject_pay_run_missing_invoice';
  END IF;
  UPDATE public.trade_invoices SET xero_bill_id='ZZTEST-bill' WHERE id=free;
  IF public.reject_trade_invoice_v1(free,'ZZTEST in Xero','user:ZZTEST-office') IS NOT NULL THEN
    RAISE EXCEPTION 'reject_pay_run_xero_bill_rejected';
  END IF;
  UPDATE public.trade_invoices SET xero_bill_id=NULL WHERE id=free;
  IF public.reject_trade_invoice_v1(free,'ZZTEST sent back','user:ZZTEST-office') IS DISTINCT FROM free THEN
    RAISE EXCEPTION 'reject_pay_run_free_invoice_refused';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=free AND status='ops-reject'
       AND query_note='ZZTEST sent back' AND office_sent_back_at IS NOT NULL) THEN
    RAISE EXCEPTION 'reject_pay_run_free_invoice_header';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE id='23000000-0000-4000-8000-000000000008')
     OR NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE id='23000000-0000-4000-8000-000000000009') THEN
    RAISE EXCEPTION 'reject_pay_run_free_invoice_lines';
  END IF;
  IF (SELECT count(*) FROM public.trade_invoice_events WHERE trade_invoice_id=free
       AND event_type='receipt_released' AND actor='user:ZZTEST-office')<>1 THEN
    RAISE EXCEPTION 'reject_pay_run_free_invoice_event: %', (SELECT jsonb_agg(jsonb_build_object('t',e.event_type,'a',e.actor,'r',e.reason)) FROM public.trade_invoice_events e WHERE trade_invoice_id=free);
  END IF;
  IF has_function_privilege('anon','public.reject_trade_invoice_v1(uuid,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.reject_trade_invoice_v1(uuid,text,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.reject_trade_invoice_v1(uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'reject_pay_run_role_boundary_changed';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reject_trade_invoice_v1(uuid,text,text)'::regprocedure)
       <> '11db2726fa12909a671fdfc400082e4e'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reject_trade_invoice_v1(uuid,text)'::regprocedure)
       <> '7f9368d57bed7d02e0a918fd20867680' THEN
    RAISE EXCEPTION 'reject_pay_run_body_unexpected';
  END IF;
END $$;
-- A second apply changes nothing.
\ir ../../../migrations/20261119090200_trade_invoice_reject_pay_run.sql
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reject_trade_invoice_v1(uuid,text,text)'::regprocedure)
       <> '11db2726fa12909a671fdfc400082e4e' THEN
    RAISE EXCEPTION 'reject_pay_run_reapply_changed_body';
  END IF;
END $$;
SELECT 'PASS: reject refuses a pay-run invoice; other refusals, release, stamp, roles and the two-argument body unchanged; re-apply is a no-op' AS result;
ROLLBACK;
