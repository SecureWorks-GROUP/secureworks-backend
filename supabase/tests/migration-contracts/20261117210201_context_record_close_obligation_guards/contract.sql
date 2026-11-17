BEGIN;
\set record_fixture_seed true
\ir setup.sql
-- The older fixture was inserted with replica mode. Attendance updates below
-- exercise normal constraints, including the real crew foreign key.
INSERT INTO public.users(id,org_id,name,role)
VALUES('00000000-0000-4000-8000-000000000499','00000000-0000-0000-0000-000000000001','trade','trade')
ON CONFLICT(id) DO NOTHING;
-- All fixtures use roles and synthetic job numbers. No money is moved.
UPDATE public.context_ledger_items SET closes_on='invoice_issued',about_key='other:final-invoice',
 what='Send the final invoice.',from_role='us',to_role='customer'
 WHERE id='00000000-0000-4000-8000-000000000402';
UPDATE public.context_ledger_items SET closes_on='payment',about_key='payment:balance',
 what='Customer owes the balance.',from_role='customer',to_role='us'
 WHERE id='00000000-0000-4000-8000-000000000410';
-- These job-linked receivables stand for the only deposit available. The guard
-- does not guess final/deposit from words, amounts or a missing deposit marker.
DO $c$
DECLARE v jsonb; s text;
BEGIN
 FOREACH s IN ARRAY ARRAY['AUTHORISED','SUBMITTED','PAID'] LOOP
  UPDATE public.xero_invoices SET status=s WHERE job_id='00000000-0000-4000-8000-000000000402';
  v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000402',false);
  IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU19: deposit closed final invoice (%)',s; END IF;
 END LOOP;
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000410',false);
 IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU19: paid deposit closed balance'; END IF;
 -- Test event bypass separately: the first probes above have ONLY a deposit.
 INSERT INTO public.job_events(job_id,event_type,created_at,detail_json)
 SELECT id,'acceptance_invoice_sent','2026-11-06T10:00:00+08','{}'::jsonb
 FROM public.jobs WHERE job_number IN ('ZZTEST-402','ZZTEST-410');
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000402',false);
 IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU19: unnumbered email event closed final invoice'; END IF;
 -- An exact invoice is an obligation the record can answer.
 UPDATE public.context_ledger_items SET about_key='invoice:inv-9002' WHERE id='00000000-0000-4000-8000-000000000402';
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000402',false);
 IF v->>'closed'<>'1' THEN RAISE EXCEPTION 'FU19: numbered issued invoice control'; END IF;
 -- Draft and hand-voided records cannot satisfy even an exact payment key.
 UPDATE public.context_ledger_items SET about_key='invoice:inv-9002' WHERE id='00000000-0000-4000-8000-000000000410';
 FOREACH s IN ARRAY ARRAY['DRAFT','VOIDED','DELETED'] LOOP
  UPDATE public.xero_invoices SET status=s WHERE job_id='00000000-0000-4000-8000-000000000410';
  v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000410',false);
  IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU19: edited invoice closed payment'; END IF;
 END LOOP;
END $c$;
SELECT 'PASS: FU19 deposit cannot close final invoice or balance; exact identity and edited invoice controls' AS result;

UPDATE public.context_ledger_items SET closes_on='payment',about_key='payment:refund',
 what='We owe the customer a refund.',from_role='us',to_role='customer'
 WHERE id='00000000-0000-4000-8000-000000000403';
-- Customer payment events must never satisfy an outgoing obligation.
INSERT INTO public.job_events(job_id,event_type,created_at,detail_json)
VALUES('00000000-0000-4000-8000-000000000403','payment_received','2026-11-06T10:00:00+08','{}'),
 ('00000000-0000-4000-8000-000000000403','payment_recorded','2026-11-06T11:00:00+08','{}');
DO $c$
DECLARE v jsonb;
BEGIN
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000403',false);
 IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU19: supplier bill or receipt closed customer refund'; END IF;
 UPDATE public.context_ledger_items SET to_role=NULL WHERE id='00000000-0000-4000-8000-000000000403';
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000403',false);
 IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU19: missing payee guessed supplier'; END IF;
 UPDATE public.context_ledger_items SET to_role='supplier',what='Pay the supplier bill.',about_key='payment:supplier'
 WHERE id='00000000-0000-4000-8000-000000000403';
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000403',false);
 IF v->>'closed'<>'1' THEN RAISE EXCEPTION 'FU19: identified supplier control'; END IF;
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000403',false);
 IF v->>'closed'<>'0' OR (SELECT count(*) FROM public.context_ledger_transitions WHERE job_id='00000000-0000-4000-8000-000000000403' AND by='rule:record_close_v1')<>1
 THEN RAISE EXCEPTION 'FU19: retry duplicated supplier close'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_ledger_record_candidates('00000000-0000-4000-8000-000000000403','payment',NULL,'2026-11-03T09:00:00+08','us'))
 THEN RAISE EXCEPTION 'FU19: legacy read guessed missing payee'; END IF;
END $c$;
SELECT 'PASS: FU19 refund, missing payee, supplier control and refusal retry' AS result;

UPDATE public.context_ledger_items SET closes_on='visit',about_key='booking:2026-11-06',
 what='Attend the booked visit.' WHERE id='00000000-0000-4000-8000-000000000407';
UPDATE public.job_assignments SET started_at='2026-11-06T10:00:00+08',completed_at='2026-11-06T11:00:00+08'
 WHERE id='00000000-0000-4000-8000-000000000407';
INSERT INTO public.job_events(job_id,event_type,created_at,detail_json)
VALUES('00000000-0000-4000-8000-000000000407','clock.clock_on','2026-11-06T10:00:00+08','{}'),
 ('00000000-0000-4000-8000-000000000407','clock.clock_off','2026-11-06T11:00:00+08','{}');
DO $c$
DECLARE v jsonb;
BEGIN
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000407',false);
 IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU19: cancelled visit closed from start or clock'; END IF;
 -- Missing attendance stays open, even on a refusal retry.
 UPDATE public.job_assignments SET status='allocated',started_at=NULL,completed_at=NULL WHERE id='00000000-0000-4000-8000-000000000407';
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000407',false);
 IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU19: missing visit proof'; END IF;
 UPDATE public.job_assignments SET started_at='2026-11-06T10:00:00+08' WHERE id='00000000-0000-4000-8000-000000000407';
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000407',false);
 IF v->>'closed'<>'1' THEN RAISE EXCEPTION 'FU19: active visit control'; END IF;
 IF has_function_privilege('anon','public.context_ledger_record_candidates(uuid,text,text,timestamptz,text,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.context_ledger_record_candidates(uuid,text,text,timestamptz,text,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.context_ledger_record_candidates(uuid,text,text,timestamptz,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'FU19: overload access'; END IF;
END $c$;
SELECT 'PASS: FU19 cancelled visit, clock bypass, missing proof, active visit and access controls' AS result;
-- A candidate read fault must leave the note open and let its page build, just
-- as the existing refresh boundary does. Replacement is rolled back below.
UPDATE public.feature_flags SET enabled=true WHERE flag_name='context_record_close_v1';
CREATE OR REPLACE FUNCTION public.context_ledger_record_candidates(
 p_job_id uuid,p_closes_on text,p_about_key text,p_opened_at timestamptz,p_from_role text,p_to_role text)
RETURNS TABLE(table_name text,record_id text,closes_at timestamptz,key text,label text)
LANGUAGE plpgsql AS $fault$ BEGIN RAISE EXCEPTION 'ZZTEST candidate read failed'; END $fault$;
DO $c$
DECLARE v jsonb;
BEGIN
 v:=public.job_page_refresh('00000000-0000-4000-8000-000000000410');
 IF v->>'outcome'<>'built' OR v#>>'{record_close,error}'<>'ZZTEST candidate read failed'
 OR NOT EXISTS(SELECT 1 FROM public.context_ledger_items WHERE id='00000000-0000-4000-8000-000000000410' AND status='open')
 THEN RAISE EXCEPTION 'FU19: read fault blocked page or closed note: %',v; END IF;
END $c$;
SELECT 'PASS: FU19 switch-on read failure keeps note open and page available' AS result;
ROLLBACK;
