BEGIN;
SET LOCAL statement_timeout='120s';
-- Earlier historical contracts can unwind the line reader. Restore its owner
-- inside this rollback transaction, then restore this case's objects.
\ir main_lines_reader.sql
CREATE TEMP TABLE reader_definition AS SELECT pg_get_viewdef('public.v_job_cost_events'::regclass,true) def;
\ir ../../../migrations/20261118023824_reconcile_tables.sql

CREATE FUNCTION pg_temp.expect_failure(command text, expected text) RETURNS void
LANGUAGE plpgsql AS $expect$
DECLARE failed boolean:=false; BEGIN
 BEGIN EXECUTE command;
 EXCEPTION WHEN OTHERS THEN
  IF position(expected IN SQLERRM)=0 THEN RAISE; END IF;
  failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'expected refusal: %',expected; END IF;
END $expect$;

INSERT INTO public.reconcile_items(id,org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by)
VALUES('00000000-0000-0000-0000-00000000c301','00000000-0000-0000-0000-000000000001',
 'bill','cost_document','xero_bill:ZZTEST-RECON','new','fixture','migration');
SELECT pg_temp.expect_failure($sql$INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by)
 SELECT org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by FROM public.reconcile_items
 WHERE id='00000000-0000-0000-0000-00000000c301'$sql$,'reconcile_items_one_open');
SELECT pg_temp.expect_failure($sql$INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by)
 VALUES('00000000-0000-0000-0000-000000000001','ZZTEST-kind','cost_document','ZZTEST-allow','new','fixture','migration')$sql$,'reconcile_items_kind_fkey');
INSERT INTO public.reconcile_item_kinds VALUES('ZZTEST-kind','other','ZZTEST kind','generic');
INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by)
VALUES('00000000-0000-0000-0000-000000000001','ZZTEST-kind','cost_document','ZZTEST-allow','new','fixture','migration');

DO $kinds$ BEGIN
 IF (SELECT count(*) FROM public.reconcile_item_kinds WHERE kind=ANY(ARRAY[
 'bill','credit','receipt','card_line','bank_line','message','weekly_check',
 'pay_claim_stopped','group_claim_no_agreement','invoice_no_work_order','pay_line_held',
 'invoice_no_job','credit_note_unmatched','credit_note_proposed','bill_reference_from_pdf',
 'draft_incomplete','message_no_job','open_item_check','agent_money_proposal','ai_job_failed']))<>20 THEN
  RAISE EXCEPTION 'P2-03.1 seeded kinds missing'; END IF;
END $kinds$;
SELECT pg_temp.expect_failure($sql$INSERT INTO public.reconcile_decisions(org_id,subject_kind,subject_id,action,"by")
 VALUES('00000000-0000-0000-0000-000000000001','cost_document','ZZTEST-decision','overhead','matcher:v1')$sql$,'reconcile_decisions_person_only');
INSERT INTO public.reconcile_decisions(org_id,subject_kind,subject_id,action,"by")
VALUES('00000000-0000-0000-0000-000000000001','cost_document','ZZTEST-decision','overhead','person:00000000-0000-0000-0000-00000000c310');
SELECT pg_temp.expect_failure($sql$UPDATE public.reconcile_decisions SET note='changed' WHERE subject_id='ZZTEST-decision'$sql$,'reconcile_decisions_append_only');
SELECT pg_temp.expect_failure($sql$DELETE FROM public.reconcile_decisions WHERE subject_id='ZZTEST-decision'$sql$,'reconcile_decisions_append_only');
SELECT pg_temp.expect_failure($sql$INSERT INTO public.reconcile_decisions(org_id,subject_kind,subject_id,action,"by")
 VALUES('00000000-0000-0000-0000-000000000001','cost_document','ZZTEST-actor','place','someone')$sql$,'reconcile_decisions_by_check');

DO $security$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['reconcile_item_kinds','reconcile_items','reconcile_decisions'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||t)::regclass)
  OR has_table_privilege('anon','public.'||t,'SELECT')
  OR has_table_privilege('authenticated','public.'||t,'INSERT') THEN
   RAISE EXCEPTION 'P2-03.1 service-only table: %',t; END IF;
 END LOOP;
 IF has_table_privilege('service_role','public.reconcile_decisions','UPDATE')
 OR has_table_privilege('service_role','public.reconcile_decisions','DELETE')
 OR has_table_privilege('service_role','public.reconcile_decisions','TRUNCATE') THEN
  RAISE EXCEPTION 'P2-03.1 log write grants'; END IF;
END $security$;

INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
 ('00000000-0000-0000-0000-00000000c330','00000000-0000-0000-0000-000000000001','ZZTEST-RECON-A','fencing','accepted'),
 ('00000000-0000-0000-0000-00000000c331','00000000-0000-0000-0000-000000000001','ZZTEST-RECON-B','fencing','accepted');
INSERT INTO public.purchase_orders(id,job_id,po_number,status,subtotal,total,created_at) VALUES
 ('00000000-0000-0000-0000-00000000c332','00000000-0000-0000-0000-00000000c330','ZZTEST-RECON-PO','sent',50,55,'2026-11-17T00:00:00Z');

-- One unresolved installer bill remains one non-actual line, even when two
-- open kinds agree. Conflicting jobs never pick a winner or multiply cost.
INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash)
VALUES('00000000-0000-0000-0000-00000000c320','00000000-0000-0000-0000-000000000001',
 'installer_bill','xero_bill','ZZTEST-RECON','1','labour',2000,'needs_person','fixture');
UPDATE public.job_cost_lines SET decision_id=(SELECT id FROM public.reconcile_decisions WHERE subject_id='ZZTEST-decision')
 WHERE id='00000000-0000-0000-0000-00000000c320';
SELECT pg_temp.expect_failure($sql$UPDATE public.job_cost_lines SET decision_id=-313
 WHERE id='00000000-0000-0000-0000-00000000c320'$sql$,'job_cost_lines_decision_fk');
CREATE TEMP TABLE main_off_rows AS SELECT to_jsonb(e) row FROM public.v_job_cost_events e;
UPDATE public.reconcile_items SET suggestion='{"job_id":"00000000-0000-0000-0000-00000000c330"}'
WHERE id='00000000-0000-0000-0000-00000000c301';
INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by,suggestion)
SELECT org_id,'open_item_check',subject_table,subject_id,reason,evidence_hash,raised_by,suggestion
FROM public.reconcile_items WHERE id='00000000-0000-0000-0000-00000000c301';
DO $suggestion$ BEGIN
 IF (SELECT count(*) FROM public.v_job_cost_events_lines WHERE cost_line_id='00000000-0000-0000-0000-00000000c320')<>1
 OR NOT EXISTS(SELECT 1 FROM public.v_job_cost_events_lines WHERE cost_line_id='00000000-0000-0000-0000-00000000c320'
  AND job_id='00000000-0000-0000-0000-00000000c330' AND amount_ex=2000
  AND source='installer_bill_unconfirmed' AND is_actual=false) THEN
  RAISE EXCEPTION 'P2-03.1 pending suggestion must be one non-actual line'; END IF;
END $suggestion$;
UPDATE public.reconcile_items SET suggestion='{"job_id":"00000000-0000-0000-0000-00000000c331"}' WHERE kind='open_item_check' AND subject_id='xero_bill:ZZTEST-RECON';
DO $conflict$ BEGIN
 IF EXISTS(SELECT 1 FROM public.v_job_cost_events_lines WHERE cost_line_id='00000000-0000-0000-0000-00000000c320') THEN
  RAISE EXCEPTION 'P2-03.1 conflicting suggestions must remain unknown'; END IF;
END $conflict$;
UPDATE public.reconcile_items SET status='withdrawn' WHERE kind='open_item_check' AND subject_id='xero_bill:ZZTEST-RECON';
UPDATE public.reconcile_items SET suggestion='{"job_id":"invalid"}' WHERE id='00000000-0000-0000-0000-00000000c301';
DO $missing$ BEGIN
 IF EXISTS(SELECT 1 FROM public.v_job_cost_events_lines WHERE cost_line_id='00000000-0000-0000-0000-00000000c320') THEN
  RAISE EXCEPTION 'P2-03.1 invalid suggestion must remain unknown'; END IF;
END $missing$;
-- An office correction or withdrawn suggestion is seen by the next read.
UPDATE public.reconcile_items SET suggestion='{"job_id":"00000000-0000-0000-0000-00000000c331"}' WHERE id='00000000-0000-0000-0000-00000000c301';
DO $office$ BEGIN
 IF (SELECT count(*) FROM public.v_job_cost_events WHERE document_number='ZZTEST-RECON-PO' AND amount_ex=50)<>1
 OR pg_get_viewdef('public.v_job_cost_events'::regclass,true)<>(SELECT def FROM reader_definition) THEN
  RAISE EXCEPTION 'P2-03.1 main reader or nonempty off fixture changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v_job_cost_events_lines WHERE cost_line_id='00000000-0000-0000-0000-00000000c320'
  AND job_id='00000000-0000-0000-0000-00000000c331') THEN RAISE EXCEPTION 'P2-03.1 office correction missing'; END IF;
 IF EXISTS((SELECT to_jsonb(e) FROM public.v_job_cost_events e EXCEPT ALL SELECT row FROM main_off_rows)
 UNION ALL (SELECT row FROM main_off_rows EXCEPT ALL SELECT to_jsonb(e) FROM public.v_job_cost_events e)) THEN
  RAISE EXCEPTION 'P2-03.1 switch off differs from main'; END IF;
END $office$;
UPDATE public.reconcile_items SET status='withdrawn' WHERE id='00000000-0000-0000-0000-00000000c301';
DO $withdraw$ BEGIN
 IF EXISTS(SELECT 1 FROM public.v_job_cost_events_lines WHERE cost_line_id='00000000-0000-0000-0000-00000000c320') THEN
  RAISE EXCEPTION 'P2-03.1 closed item still suggests a job'; END IF;
END $withdraw$;
-- A refused log update can be retried without altering the existing decision.
SELECT pg_temp.expect_failure($sql$UPDATE public.reconcile_decisions SET note='retry' WHERE subject_id='ZZTEST-decision'$sql$,'reconcile_decisions_append_only');

SAVEPOINT plan_fixture;
INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by,suggestion)
SELECT '00000000-0000-0000-0000-000000000001','bill','cost_document','xero_bill:ZZTEST-OTHER-'||n,
 'new','fixture','migration','{"job_id":"00000000-0000-0000-0000-00000000c330"}' FROM generate_series(1,12000) n;
UPDATE public.reconcile_items SET status='open',suggestion='{"job_id":"00000000-0000-0000-0000-00000000c330"}'
 WHERE id='00000000-0000-0000-0000-00000000c301';
ANALYZE public.reconcile_items;
ANALYZE public.job_cost_lines;
DO $plan$ DECLARE plan jsonb; BEGIN
 EXECUTE $q$EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
 SELECT * FROM public.v_job_cost_events_lines WHERE cost_line_id='00000000-0000-0000-0000-00000000c320'$q$ INTO plan;
 IF EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == "reconcile_items")') node
  WHERE node->>'Node Type'='Seq Scan' AND (node->>'Actual Loops')::numeric>0)
 OR NOT EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == "reconcile_items")') node
  WHERE node->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan') AND (node->>'Actual Loops')::numeric>0)
 OR EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == "reconcile_items")') node
  WHERE (node->>'Actual Loops')::numeric>0 AND
  coalesce((node->>'Actual Rows')::numeric,0)+coalesce((node->>'Rows Removed by Filter')::numeric,0)>2) THEN
  RAISE EXCEPTION 'P2-03.1 suggestion lookup must be bounded and indexed: %',plan; END IF;
END $plan$;
ROLLBACK TO plan_fixture;

SELECT 'PASS P2-03.1: list uniqueness, extensible kinds, person guard, append-only log, service boundary, pending suggestion and off parity';
ROLLBACK;
