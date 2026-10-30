-- Synthetic source documents; no real payment, allocation or send.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE h7_credit_checks(name text,passed boolean);
CREATE TEMP TABLE h7_credit_reads(phase text,body jsonb);
CREATE FUNCTION pg_temp.prove(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'H7 note credit: %',n;END IF;
 INSERT INTO h7_credit_checks VALUES(n,p);
END $$;
DO $test$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001';j uuid:=gen_random_uuid();j2 uuid:=gen_random_uuid();
 bill text:=gen_random_uuid()::text;cn text:=gen_random_uuid()::text;n jsonb;a jsonb;b record;h0 text;h1 text;p jsonb;cnt numeric;
BEGIN
 INSERT INTO organisations(id,name) VALUES(org,'Synthetic H7 credit organisation') ON CONFLICT(id) DO NOTHING;
 INSERT INTO jobs(id,org_id,status,type,job_number,metadata,created_at) VALUES
 (j,org,'in_progress','fencing','SWF-H7C-1','{}','2026-09-01'),(j2,org,'in_progress','patio','SWP-H7C-2','{}','2026-09-01');
 INSERT INTO xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,sub_total,total,invoice_date,line_items,raw_json,job_id) VALUES
 (org,bill,'H7C-BILL','ACCPAY','AUTHORISED',1000,1100,'2026-10-01','[{"Description":"Steel","AccountCode":"310","LineAmount":1000}]','{"Total":1100}',j);
 SELECT * INTO b FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill;
 h0:=b.evidence_hash;
 PERFORM pg_temp.prove('absent credit evidence stays unknown',b.credit_applied_ex IS NULL AND b.counted_ex=1000);
 INSERT INTO h7_credit_reads VALUES('plain',context_job_bill_outcomes(j));
 n:=jsonb_build_object('xero_credit_note_id',cn,'credit_note_type','ACCPAYCREDIT','credit_note_number','H7C-CREDIT','status','AUTHORISED','currency_code','AUD',
 'credit_note_date','2026-10-02','sub_total',100,'total_tax',10,'total',110,'remaining_credit',0,'xero_updated_at','2026-10-20T00:00:00Z','raw_json','{}'::jsonb);
 a:=jsonb_build_array(jsonb_build_object('xero_invoice_id',bill,'amount',110,'allocation_date','2026-10-02','is_deleted',false));
 PERFORM xero_supplier_credit_note_copy(org,n,a);
 SELECT * INTO b FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill;
 RAISE NOTICE 'note-only actual: counted %, credit %, hash_changed %',b.counted_ex,b.credit_applied_ex,b.evidence_hash<>h0;
 PERFORM pg_temp.prove('note-side credit amount matches authoritative netting',b.credit_applied_ex=100 AND b.counted_ex=900);
 PERFORM pg_temp.prove('note-only correction changes H7 witness',b.evidence_hash<>h0);
 p:=context_job_bill_outcomes(j);
 PERFORM pg_temp.prove('Context receives exact changed witness',p->'bills'->0->>'change_hash'=b.evidence_hash);
 PERFORM pg_temp.prove('Context retains placement truth',p->'bills'->0->>'where_counted'='here');
 INSERT INTO h7_credit_reads VALUES('note',p);h1:=b.evidence_hash;
 PERFORM xero_supplier_credit_note_copy(org,n||'{"xero_updated_at":"2026-10-20T01:00:00Z"}',a);
 PERFORM pg_temp.prove('copy clock alone stays quiet',(SELECT evidence_hash FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill)=h1);
 UPDATE xero_invoices SET status='PAID',amount_paid=1100,amount_due=0,fully_paid_on='2026-10-21' WHERE xero_invoice_id=bill;
 PERFORM pg_temp.prove('D22 bill payment does not move H7 witness',(SELECT evidence_hash FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill)=h1);
 PERFORM xero_supplier_credit_note_copy(org,n||'{"status":"PAID","fully_paid_on":"2026-10-21","xero_updated_at":"2026-10-20T02:00:00Z"}',a);
 PERFORM pg_temp.prove('D22 note settlement does not move H7 witness',(SELECT evidence_hash FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill)=h1);
 INSERT INTO h7_credit_reads VALUES('paid',context_job_bill_outcomes(j));
 PERFORM xero_supplier_credit_note_copy(org,n||'{"credit_note_date":"2026-10-03","xero_updated_at":"2026-10-20T03:00:00Z"}',a);
 SELECT * INTO b FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill;
 PERFORM pg_temp.prove('corrected original credit date changes witness at same amount',b.evidence_hash<>h1 AND b.counted_ex=900 AND b.credit_applied_ex=100);h1:=b.evidence_hash;
 INSERT INTO h7_credit_reads VALUES('date_corrected',context_job_bill_outcomes(j));
 UPDATE xero_invoices SET raw_json=jsonb_build_object('Total',1100,'AmountCredited',110,'CreditNotes',jsonb_build_array(jsonb_build_object('CreditNoteID',cn,'AppliedAmount',110))) WHERE xero_invoice_id=bill;
 SELECT * INTO b FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill;
 PERFORM pg_temp.prove('bill mirror of same credit does not double the field',b.credit_applied_ex=100 AND b.counted_ex=900);
 UPDATE xero_invoices SET raw_json='{"Total":1100,"AmountCredited":110}' WHERE xero_invoice_id=bill;
 PERFORM pg_temp.prove('bill amount fallback does not double the field',(SELECT credit_applied_ex FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill)=100);
 UPDATE xero_invoices SET raw_json=jsonb_build_object('Total',1100,'CreditNotes',jsonb_build_array(jsonb_build_object('CreditNoteID','different-source-credit','AppliedAmount',55))) WHERE xero_invoice_id=bill;
 SELECT * INTO b FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill;
 PERFORM pg_temp.prove('different bill credit adds to note credit once',b.credit_applied_ex=150 AND b.counted_ex=850);
 UPDATE xero_invoices SET raw_json='{"Total":1100}' WHERE xero_invoice_id=bill;
 INSERT INTO job_materials_facts(xero_invoice_id,job_id,lane,kind,amount_ex_gst,automation_source,fact_date) VALUES
 (bill,j,'materials','actual',600,'manual_split','2026-10-01'),(bill,j2,'materials','actual',400,'manual_split','2026-10-01');
 SELECT * INTO b FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill AND job_id=j;
 PERFORM pg_temp.prove('split keeps per-bill credit distinct from job portion',b.credit_applied_ex=100 AND b.counted_ex=540);
 PERFORM pg_temp.prove('other split part uses same bill credit',(SELECT counted_ex FROM cfo_bill_cost_outcomes_scoped(j2) WHERE xero_invoice_id=bill AND job_id=j2)=360);
 PERFORM pg_temp.prove('scoped and estate rows identical',NOT EXISTS((SELECT * FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill EXCEPT SELECT * FROM cfo_bill_cost_outcomes WHERE xero_invoice_id=bill) UNION ALL(SELECT * FROM cfo_bill_cost_outcomes WHERE xero_invoice_id=bill EXCEPT SELECT * FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill)));
 INSERT INTO h7_credit_reads VALUES('split',context_job_bill_outcomes(j));
 DELETE FROM job_materials_facts WHERE xero_invoice_id=bill;
 PERFORM pg_temp.prove('Undo restores cost and credit',(SELECT credit_applied_ex=100 AND counted_ex=900 FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill));
 INSERT INTO materials_reconciliation_queue(xero_invoice_id,invoice_number,contact_name,sub_total,total,invoice_date,status) VALUES(bill,'H7C-BILL','Synthetic supplier',1000,1100,'2026-10-01','not_job_related');
 p:=context_job_bill_outcomes(j);
 PERFORM pg_temp.prove('F1 conflicting mark remains held',p->'bills'->0->>'where_counted'='held' AND p->'bills'->0->'here'->>'counts'='held');
 INSERT INTO h7_credit_reads VALUES('held',p);
 DELETE FROM materials_reconciliation_queue WHERE xero_invoice_id=bill;
 PERFORM xero_supplier_credit_note_copy(org,n||'{"status":"VOIDED","xero_updated_at":"2026-10-20T04:00:00Z"}',a);
 SELECT * INTO b FROM cfo_bill_cost_outcomes_scoped(j) WHERE xero_invoice_id=bill;
 PERFORM pg_temp.prove('void removes note deduction without claiming known zero',b.counted_ex=1000 AND b.credit_applied_ex IS NULL);
 INSERT INTO h7_credit_reads VALUES('void',context_job_bill_outcomes(j));
 PERFORM pg_temp.prove('no credit sources restores baseline financial witness',b.evidence_hash=h0);
 PERFORM pg_temp.prove('H7 contract version preserved',b.contract_version='cfo-bill-cost-outcome-v1');
 PERFORM pg_temp.prove('H7 rule remains inlinable invoker',EXISTS(SELECT 1 FROM pg_proc WHERE oid='cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure AND NOT prosecdef AND proconfig IS NULL AND provolatile='s'));
 PERFORM pg_temp.prove('H7 service-only privilege preserved',has_function_privilege('service_role','cfo_bill_cost_outcomes_scoped(uuid)','EXECUTE') AND NOT has_function_privilege('anon','cfo_bill_cost_outcomes_scoped(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','cfo_bill_cost_outcomes_scoped(uuid)','EXECUTE'));
END $test$;
SELECT jsonb_build_object('checks',(SELECT jsonb_agg(to_jsonb(c)) FROM h7_credit_checks c),'count',(SELECT count(*) FROM h7_credit_checks),'snapshots',(SELECT jsonb_agg(to_jsonb(s)) FROM h7_credit_reads s),'scope','synthetic actual SQL/Context result; no independent or live/staff acceptance');
ROLLBACK;
