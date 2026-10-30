-- Independent arithmetic from these synthetic source documents, not view totals.
-- Group share100 + employer12, commission200 + employer24; advance1000 +120
-- are nonactual. Materials1000 less allocated credit100 => actual1236.
-- Copies and all fixture writes roll back. No pay, external writes or approvals.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE combo_checks(name text,passed boolean);
CREATE FUNCTION pg_temp.prove(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'credit labour composition: %',n;END IF;
 INSERT INTO combo_checks VALUES(n,p);
END $$;
DO $test$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001';j uuid:=gen_random_uuid();j2 uuid:=gen_random_uuid();u uuid:=gen_random_uuid();ti uuid:=gen_random_uuid();
 bill text:=gen_random_uuid()::text;cn text:=gen_random_uuid()::text;n jsonb;a jsonb;s text;
BEGIN
 INSERT INTO organisations(id,name) VALUES(org,'Synthetic integrated organisation') ON CONFLICT(id) DO NOTHING;
 INSERT INTO jobs(id,org_id,status,type,job_number,metadata,pricing_json,created_at) VALUES
 (j,org,'in_progress','fencing','SWF-COMBO-1','{}','{}','2026-09-01'),(j2,org,'in_progress','patio','SWP-COMBO-2','{}','{}','2026-09-01');
 INSERT INTO users(id,org_id,name) VALUES(u,org,'Synthetic integrated crew');
 INSERT INTO trade_invoices(id,org_id,user_id,week_start,status,subtotal_ex,gst,total_inc,invoice_number,gst_on,super_rate,gross_earned,super_amount,net_pay,super_basis)
 VALUES(ti,org,u,'2026-10-19','approved',1300,0,1300,'COMBO-CREW',false,.12,1300,156,1300,'employer_12_v2');
 -- Load captured-shape lines only, matching original Group WO cost-view contract.
 -- This does not exercise group release/approval or its snapshot trigger.
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO trade_invoice_lines(trade_invoice_id,job_id,line_type,description,total_hours,line_total_ex,line_date) VALUES
 (ti,j,'group share','Synthetic approved group share',2,100,'2026-10-20'),
 (ti,j,'commission','Synthetic commission source; not a new approval',1,200,'2026-10-20'),
 (ti,j,'labour','Commission Advance',1,1000,'2026-10-20');
 PERFORM set_config('session_replication_role','origin',true);
 INSERT INTO xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,sub_total,total,invoice_date,line_items,raw_json,job_id) VALUES
 (org,bill,'COMBO-MATERIAL','ACCPAY','AUTHORISED',1000,1100,'2026-10-01','[{"Description":"Steel","AccountCode":"310","LineAmount":1000}]','{"Total":1100}',j),
 (org,gen_random_uuid(),'COMBO-MIRROR','ACCPAY','PAID',1300,1300,'2026-10-20','[{"Description":"Crew | SW - FENCING","AccountCode":"306","LineAmount":1300}]','{}',j);
 INSERT INTO feature_flags(flag_name,enabled) VALUES('job_cost_employer_super_v1',true) ON CONFLICT(flag_name) DO UPDATE SET enabled=true;
 PERFORM pg_temp.prove('native group share stays labour',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND lane='labour' AND source='trade_line' AND is_actual)=100);
 PERFORM pg_temp.prove('native labour and commission super once',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND source='trade_employer_super' AND is_actual)=36);
 PERFORM pg_temp.prove('advance and its oncost stay nonactual',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND lane='advance' AND NOT is_actual)=1120);
 PERFORM pg_temp.prove('no actual advance',(SELECT count(*) FROM v_job_cost_events WHERE job_id=j AND lane='advance' AND is_actual)=0);
 PERFORM pg_temp.prove('super not marked paid',(SELECT count(*) FROM v_job_cost_events WHERE job_id=j AND source='trade_employer_super' AND (paid OR paid_on IS NOT NULL))=0);
 PERFORM pg_temp.prove('native mirror bill not counted again',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND is_actual)=1336);
 n:=jsonb_build_object('xero_credit_note_id',cn,'credit_note_type','ACCPAYCREDIT','credit_note_number','COMBO-CREDIT','status','AUTHORISED','currency_code','AUD','credit_note_date','2026-10-02','sub_total',100,'total_tax',10,'total',110,'remaining_credit',0,'xero_updated_at','2026-10-20T00:00:00Z','raw_json','{}'::jsonb);
 a:=jsonb_build_array(jsonb_build_object('xero_invoice_id',bill,'amount',110,'allocation_date','2026-10-02','is_deleted',false));
 s:=context_job_story_money_sig(j);
 PERFORM xero_supplier_credit_note_copy(org,n,a);
 PERFORM pg_temp.prove('allocated supplier credit counted once beside native oncost',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND is_actual)=1236);
 PERFORM pg_temp.prove('profit consumer reads same integrated actual',(SELECT actual_cost_ex FROM v_job_profit WHERE job_id=j)=1236);
 PERFORM pg_temp.prove('financial change moves reader story witness',context_job_story_money_sig(j)<>s);
 PERFORM pg_temp.prove('unpriced expectations retain incomplete book',NOT(context_job_story_book(j)->>'complete')::boolean);
 PERFORM pg_temp.prove('credit placement reports note side',(SELECT count(*) FROM v_supplier_credit_placement WHERE xero_credit_note_id=cn AND job_id=j AND job_profit='counted_from_credit_note' AND counted_ex=100)=1);
 UPDATE xero_invoices SET raw_json=jsonb_build_object('Total',1100,'AmountCredited',110,'CreditNotes',jsonb_build_array(jsonb_build_object('CreditNoteID',cn,'AppliedAmount',110))) WHERE xero_invoice_id=bill;
 PERFORM pg_temp.prove('bill and credit-note copies never double count',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND is_actual)=1236);
 PERFORM pg_temp.prove('bill-side witness reports existing credit',(SELECT count(*) FROM v_supplier_credit_placement WHERE xero_credit_note_id=cn AND job_id=j AND job_profit='counted_by_bill')=1);
 UPDATE xero_invoices SET raw_json='{"Total":1100,"AmountCredited":110}' WHERE xero_invoice_id=bill;
 PERFORM pg_temp.prove('amount credited fallback never doubles note',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND is_actual)=1236);
 UPDATE xero_invoices SET raw_json='{"Total":1100}' WHERE xero_invoice_id=bill;
 INSERT INTO job_materials_facts(xero_invoice_id,job_id,lane,kind,amount_ex_gst,automation_source,fact_date) VALUES
 (bill,j,'materials','actual',600,'manual_split','2026-10-01'),(bill,j2,'materials','actual',400,'manual_split','2026-10-01');
 PERFORM pg_temp.prove('split keeps crew and sixty percent of credit',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND is_actual)=876);
 PERFORM pg_temp.prove('split routes forty percent to second job',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j2 AND is_actual)=360);
 PERFORM pg_temp.prove('split conserves combined source total',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id IN(j,j2) AND is_actual)=1236);
 DELETE FROM job_materials_facts WHERE xero_invoice_id=bill;
 PERFORM pg_temp.prove('Undo split restores original job cost',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND is_actual)=1236 AND NOT EXISTS(SELECT 1 FROM v_job_cost_events WHERE job_id=j2));
 UPDATE feature_flags SET enabled=false WHERE flag_name='job_cost_employer_super_v1';
 PERFORM pg_temp.prove('super off leaves credits correct',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND is_actual)=1200);
 DELETE FROM feature_flags WHERE flag_name='job_cost_employer_super_v1';
 PERFORM pg_temp.prove('super missing flag also leaves credits correct',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND is_actual)=1200);
 INSERT INTO feature_flags(flag_name,enabled) VALUES('job_cost_employer_super_v1',true);
 PERFORM xero_supplier_credit_note_copy(org,n||'{"status":"VOIDED","xero_updated_at":"2026-10-20T01:00:00Z"}',a);
 PERFORM pg_temp.prove('void restores material cost but preserves super',(SELECT sum(amount_ex) FROM v_job_cost_events WHERE job_id=j AND is_actual)=1336);
 PERFORM pg_temp.prove('void is visible unplaced',(SELECT count(*) FROM v_supplier_credit_placement WHERE xero_credit_note_id=cn AND job_id IS NULL AND state='credit_note_not_live')>=1);
 PERFORM pg_temp.prove('anon cannot read money view',NOT has_table_privilege('anon','v_job_cost_events','SELECT'));
 PERFORM pg_temp.prove('service can read money view',has_table_privilege('service_role','v_job_cost_events','SELECT'));
END $test$;
SELECT jsonb_build_object('checks',jsonb_agg(to_jsonb(combo_checks)),'count',count(*),'scope','synthetic source math through actual composed views; self-run, no production or independent acceptance') FROM combo_checks;
ROLLBACK;
