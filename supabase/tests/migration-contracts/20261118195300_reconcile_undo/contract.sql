\set ON_ERROR_STOP on
BEGIN;
-- 20261118196000 patches this body; take its switch check out before re-applying.
\ir ../../../rollbacks/20261118196000_reconcile_decide_switch_in_database_down.sql
\ir ../../../migrations/20261118195300_reconcile_undo.sql
CREATE TEMP TABLE undo_checks(label text);
CREATE FUNCTION pg_temp.check_it(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'failed: %',label; END IF;
 INSERT INTO undo_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.refusal(d bigint,who uuid,expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
   PERFORM public.reconcile_undo(d,who);
   RAISE EXCEPTION 'expected refusal';
 EXCEPTION WHEN OTHERS THEN
   IF SQLERRM <> expected OR (expected='reconcile_not_staff' AND SQLSTATE <> '42501') THEN RAISE; END IF;
 END;
 INSERT INTO undo_checks VALUES(expected);
END $$;
INSERT INTO public.users(id,org_id,name,role) VALUES
 ('03040000-0000-4000-8000-000000000001','00000000-0000-0000-0000-0000000000a1','office','ops_manager'),
 ('03040000-0000-4000-8000-000000000002','00000000-0000-0000-0000-0000000000a1','trade','installer'),
 ('03040000-0000-4000-8000-000000000003','00000000-0000-0000-0000-0000000000b1','office','admin');
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
 ('03040000-0000-4000-8000-000000000004','00000000-0000-0000-0000-0000000000a1','ZZTEST-0304','fencing','accepted');
INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,source_hash,state,needs_reason,lane,amount_ex)
 SELECT '00000000-0000-0000-0000-0000000000a1','supplier_bill','xero_bill','ZZTEST-0304-'||d,'1',
   'source','needs_person','new','materials',12 FROM unnest(ARRAY['place','split','auto','bare','changed','other','proof','later']) d;
CREATE FUNCTION pg_temp.staff() RETURNS uuid LANGUAGE sql AS $$ SELECT '03040000-0000-4000-8000-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.subject(d text) RETURNS text LANGUAGE sql AS $$ SELECT 'xero_bill:ZZTEST-0304-'||d $$;
CREATE FUNCTION pg_temp.item(d text) RETURNS uuid LANGUAGE sql AS $$
 SELECT public.reconcile_item_raise('bill','cost_document',pg_temp.subject(d),'{}','{"outcome":"job","clue_ids":[1]}',
   '{"reason":"one_clue","summary":{"number":"ZZTEST"}}','matcher:v1');
$$;
CREATE FUNCTION pg_temp.decide(i uuid,action text,parts jsonb) RETURNS bigint LANGUAGE sql AS $$
 SELECT (public.reconcile_decide(i,evidence_hash,action,parts,NULL,false,pg_temp.staff())->>'decision_id')::bigint
 FROM public.reconcile_items WHERE id=i
$$;
CREATE FUNCTION pg_temp.lines(d text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.reconcile_undo_lines('00000000-0000-0000-0000-0000000000a1','xero_bill','ZZTEST-0304-'||d)
$$;
CREATE FUNCTION pg_temp.auto_place(d text,run_id uuid,order_ref text DEFAULT 'ZZTEST-order') RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.match_apply('cost_document',pg_temp.subject(d),run_id,'bill',
   jsonb_build_array(jsonb_build_object('clue_code','job_number','root','doc:'||d,'outcome','job',
     'job_id','03040000-0000-4000-8000-000000000004','names_one',true),
     jsonb_build_object('clue_code','sealed_scope_order','root','order:'||order_ref,'outcome','job',
     'job_id','03040000-0000-4000-8000-000000000004','names_one',true,
     'detail',jsonb_build_object('order_kind','dispatch_order','order_id',order_ref))),
   '{"result":"auto","job_id":"03040000-0000-4000-8000-000000000004","clue_indexes":[0,1]}','[]','{}','v1')
$$;
DO $person$
DECLARE i uuid:=pg_temp.item('place'); prev public.reconcile_items; d bigint; u jsonb;
 lines jsonb:=pg_temp.lines('place'); placed jsonb; split_item uuid; split_line uuid;
BEGIN
 SELECT * INTO STRICT prev FROM public.reconcile_items WHERE id=i;
 d:=pg_temp.decide(i,'place','[{"job_id":"03040000-0000-4000-8000-000000000004"}]');
 placed:=pg_temp.lines('place');
 PERFORM pg_temp.check_it(placed#>>'{0,state}'='on_job','person placed the line');
 PERFORM pg_temp.refusal(d,'03040000-0000-4000-8000-000000000002','reconcile_not_staff');
 PERFORM pg_temp.refusal(d,'03040000-0000-4000-8000-000000000003','reconcile_not_staff');
 u:=public.reconcile_undo(d,pg_temp.staff());
 PERFORM pg_temp.check_it(pg_temp.lines('place')=lines AND u->>'restored_item_id'=i::text
   AND EXISTS(SELECT FROM public.reconcile_items WHERE id=i AND suggestion=prev.suggestion
    AND status='open' AND decision_id IS NULL AND closed_at IS NULL AND evidence_hash=prev.evidence_hash),
   'same line, no parts, same open item, hash and suggestion');
 PERFORM pg_temp.check_it((SELECT count(*)=2 FROM public.reconcile_decisions WHERE subject_id=pg_temp.subject('place'))
   AND EXISTS(SELECT FROM public.reconcile_decisions WHERE id=(u->>'decision_id')::bigint AND action='undo'
    AND "by"='person:'||pg_temp.staff() AND supersedes=d AND before->'lines'=placed),'append-only undo before-image');
 PERFORM pg_temp.refusal(d,pg_temp.staff(),'reconcile_not_latest');
 PERFORM pg_temp.refusal((u->>'decision_id')::bigint,pg_temp.staff(),'reconcile_not_latest');
 split_item:=pg_temp.item('split'); lines:=pg_temp.lines('split'); split_line:=(lines#>>'{0,id}')::uuid;
 d:=pg_temp.decide(split_item,'split',jsonb_build_array(
   jsonb_build_object('line_id',split_line,'target','overhead','amount_ex',4),
   jsonb_build_object('line_id',split_line,'target','job','amount_ex',8,'job_id','03040000-0000-4000-8000-000000000004')));
 PERFORM pg_temp.check_it(jsonb_array_length(pg_temp.lines('split')#>'{0,parts}')=2,'person split');
 PERFORM public.reconcile_undo(d,pg_temp.staff());
 PERFORM pg_temp.check_it(pg_temp.lines('split')=lines,'removed both split parts');
END $person$;

DO $faults$
DECLARE i uuid:=pg_temp.item('changed'); d bigint; newer uuid; missing bigint := -1;
BEGIN
 PERFORM pg_temp.refusal(missing,pg_temp.staff(),'reconcile_not_latest');
 d:=pg_temp.decide(i,'overhead',NULL);
 UPDATE public.job_cost_lines SET amount_ex=13 WHERE document_id='ZZTEST-0304-changed';
 PERFORM pg_temp.refusal(d,pg_temp.staff(),'reconcile_document_changed');
 PERFORM pg_temp.refusal(d,pg_temp.staff(),'reconcile_document_changed');
 UPDATE public.job_cost_lines SET amount_ex=12,source_hash='new' WHERE document_id='ZZTEST-0304-changed';
 PERFORM pg_temp.refusal(d,pg_temp.staff(),'reconcile_document_changed');
 PERFORM pg_temp.check_it((SELECT count(*)=1 FROM public.reconcile_decisions WHERE subject_id=pg_temp.subject('changed'))
   AND EXISTS(SELECT FROM public.reconcile_items WHERE id=i AND status='decided')
   AND pg_temp.lines('changed')#>>'{0,state}'='overhead','refusals preserve the decision and office changes');
 UPDATE public.job_cost_lines SET source_hash='source' WHERE document_id='ZZTEST-0304-changed';
 INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,source_hash,state,lane,amount_ex)
   SELECT org_id,kind,document_kind,document_id,'added',source_hash,'needs_person',lane,1
    FROM public.job_cost_lines WHERE document_id='ZZTEST-0304-changed';
 PERFORM pg_temp.refusal(d,pg_temp.staff(),'reconcile_document_changed');
 i:=pg_temp.item('other'); d:=pg_temp.decide(i,'overhead',NULL);
 newer:=public.reconcile_item_raise('bill','cost_document',pg_temp.subject('other'),'{}',NULL,
   '{"reason":"different"}','matcher:v1');
 PERFORM pg_temp.check_it(public.reconcile_undo(d,pg_temp.staff())->>'restored_item_id'=newer::text,'keep newer open item');
 PERFORM pg_temp.check_it((SELECT status='withdrawn' FROM public.reconcile_items WHERE id=i)
   AND (SELECT status='open' AND reason='different' FROM public.reconcile_items WHERE id=newer),'old item withdrawn');
 i:=pg_temp.item('later'); d:=pg_temp.decide(i,'leave',NULL);
 PERFORM pg_temp.decide(i,'overhead',NULL);
 PERFORM pg_temp.refusal(d,pg_temp.staff(),'reconcile_not_latest');
END $faults$;

DO $matcher$
DECLARE d text; i uuid; result jsonb; decision bigint; lines jsonb; run_id uuid;
 original_hash text; original_suggestion jsonb; receipt bigint;
BEGIN
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='reconcile_matcher_v1';
 lines:=pg_temp.lines('bare');
 PERFORM pg_temp.check_it(pg_temp.auto_place('bare',gen_random_uuid())='{"applied":"shadow"}'
   AND pg_temp.lines('bare')=lines,'switch off retains shadow');
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='reconcile_matcher_v1';
 FOREACH d IN ARRAY ARRAY['auto','bare','proof'] LOOP
   i:=NULL; run_id:=gen_random_uuid();
   IF d='auto' THEN
     i:=pg_temp.item(d);
     SELECT r.evidence_hash,r.suggestion INTO original_hash,original_suggestion FROM public.reconcile_items r WHERE id=i;
   END IF;
   lines:=pg_temp.lines(d);
   result:=pg_temp.auto_place(d,run_id); decision:=(result->>'decision_id')::bigint;
   PERFORM pg_temp.check_it(result->>'applied'='auto' AND pg_temp.lines(d)#>>'{0,order_id}'='ZZTEST-order',
     'actual automatic placement');
   IF d='proof' THEN
     DELETE FROM public.match_clues WHERE id=(SELECT clue_ids[1] FROM public.reconcile_decisions WHERE id=decision);
     PERFORM pg_temp.refusal(decision,pg_temp.staff(),'reconcile_match_evidence_missing');
     PERFORM pg_temp.check_it(pg_temp.lines(d)#>>'{0,state}'='on_job'
       AND NOT EXISTS(SELECT FROM public.reconcile_items WHERE subject_id=pg_temp.subject(d)),'missing proof rolls back undo');
     CONTINUE;
   END IF;
   result:=public.reconcile_undo(decision,pg_temp.staff()); receipt:=(result->>'decision_id')::bigint;
   IF d='bare' THEN i:=(result->>'restored_item_id')::uuid; END IF;
   PERFORM pg_temp.check_it(result->>'restored_item_id'=i::text AND pg_temp.lines(d)=lines
     AND EXISTS(SELECT FROM public.reconcile_items r WHERE r.id=i AND r.status='open' AND r.reason='undone_by_person'
       AND (d='bare' OR (r.evidence_hash=original_hash AND r.suggestion=original_suggestion AND r.summary='{"number":"ZZTEST"}'))),
     'exact restore and open undo hold');
   PERFORM pg_temp.check_it(pg_temp.auto_place(d,run_id)='{"applied":"held_by_person"}','same run stays held');
   PERFORM pg_temp.check_it(pg_temp.auto_place(d,gen_random_uuid())='{"applied":"held_by_person"}','fresh run same evidence stays held');
   PERFORM pg_temp.check_it(pg_temp.lines(d)=lines AND EXISTS(SELECT FROM public.reconcile_items WHERE id=i
     AND status='open' AND reason='undone_by_person') AND (SELECT count(*)=2 FROM public.reconcile_decisions
     WHERE subject_id=pg_temp.subject(d)), 'replay writes no placement, item change or decision');
   IF d='bare' THEN
     PERFORM pg_temp.decide(i,'leave',NULL);
     PERFORM pg_temp.check_it(pg_temp.auto_place(d,gen_random_uuid())='{"applied":"held_by_person"}','snooze keeps the stop');
     PERFORM pg_temp.decide(i,'division_stock','[{"division":"fencing"}]');
     PERFORM pg_temp.check_it(pg_temp.auto_place(d,gen_random_uuid())='{"applied":"held_by_person"}'
      AND pg_temp.lines(d)#>>'{0,state}'='division_stock','person can decide the held item');
   ELSE
     PERFORM pg_temp.check_it(pg_temp.auto_place(d,gen_random_uuid(),'ZZTEST-other-order')->>'applied'='auto',
       'materially different deciding clue is rechecked');
     PERFORM pg_temp.check_it(pg_temp.auto_place(d,gen_random_uuid())='{"applied":"held_by_person"}'
       AND pg_temp.lines(d)#>>'{0,order_id}'='ZZTEST-other-order','intervening matcher cannot release a person hold');
   END IF;
 END LOOP;
END $matcher$;

-- Restore a pre-existing allocation with its original part number and lane.
DO $old_part$
DECLARE d bigint; i uuid; original jsonb; line_id uuid; j uuid:='03040000-0000-4000-8000-000000000004';
BEGIN
 INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,source_hash,state,lane,amount_ex,
   order_kind,order_id,decided_by_kind) VALUES('00000000-0000-0000-0000-0000000000a1','supplier_bill','xero_bill',
   'ZZTEST-0304-old','1','old','on_job','materials',12,'purchase_order','ZZTEST-old-order','source') RETURNING id INTO line_id;
 INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
   VALUES(line_id,7,'job',j,'materials',12);
 original:=pg_temp.lines('old'); i:=pg_temp.item('old'); d:=pg_temp.decide(i,'overhead',NULL);
 DELETE FROM public.job_profit_dirty WHERE job_id=j;
 PERFORM public.reconcile_undo(d,pg_temp.staff());
 PERFORM pg_temp.check_it(pg_temp.lines('old')=original AND EXISTS(SELECT FROM public.job_profit_dirty WHERE job_id=j),
   'prior non-person allocation, order, original part number and job profit mark restored');
END $old_part$;

GRANT SELECT,UPDATE ON public.jobs,public.feature_flags TO service_role;
REVOKE SELECT ON public.reconcile_decisions FROM PUBLIC,service_role;
SET LOCAL ROLE service_role;
DO $fault$
BEGIN
 BEGIN
   PERFORM public.match_apply('cost_document','xero_bill:ZZTEST-0304-auto',gen_random_uuid(),'bill','[]',
     '{"result":"none","reason":"no_clue"}','[]','{}','v1');
   RAISE EXCEPTION 'read_fault_was_accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $fault$;
RESET ROLE;
GRANT SELECT ON public.reconcile_decisions TO service_role;
SELECT pg_temp.check_it(pg_temp.lines('auto')#>>'{0,order_id}'='ZZTEST-other-order'
 AND EXISTS(SELECT FROM public.match_clues WHERE current AND subject_id=pg_temp.subject('auto')),
 'unreadable stop rolls back the run');

-- Exercise the actual context writer when the registered context stack is present.
SELECT to_regprocedure('public.context_recon_evidence_hash(uuid)') IS NOT NULL AS has_context \gset
\if :has_context
DO $message$
DECLARE ev uuid:=gen_random_uuid(); h text; original bigint; d bigint; i uuid; undo_result jsonb;
BEGIN
 INSERT INTO public.business_events(id,channel,direction,occurred_at,payload,event_type,source,provider_message_id)
   VALUES(ev,'sms','inbound',now(),'{}','sms.inbound','recon-contract','zztest-0304-'||ev::text);
 h:=public.context_recon_evidence_hash(ev);
 original:=public.context_recon_record_decision(ev,h,'unrelated','{}','ambiguity:several_candidates',pg_temp.staff());
 INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by,status,closed_at)
   VALUES('00000000-0000-0000-0000-0000000000a1','message','business_events',ev::text,'message',h,'context:daily_list','decided',now())
   RETURNING id INTO i;
 INSERT INTO public.reconcile_decisions(org_id,item_id,subject_kind,subject_id,action,before,"by",context_decision_id)
   VALUES('00000000-0000-0000-0000-0000000000a1',i,'business_events',ev::text,'message',
   '{"item":{"status":"open"}}','person:'||pg_temp.staff(),original) RETURNING id INTO d;
 UPDATE public.reconcile_items SET decision_id=d WHERE id=i;
 undo_result:=public.reconcile_undo(d,pg_temp.staff());
 PERFORM pg_temp.check_it(undo_result->>'restored_item_id'=i::text AND EXISTS(
   SELECT FROM public.context_reconciliation_decisions c JOIN public.reconcile_decisions u ON u.context_decision_id=c.id
   WHERE u.id=(undo_result->>'decision_id')::bigint AND c.subject_id=ev AND c.action='unresolved'
     AND c.supersedes=original AND c."by"='person:'||pg_temp.staff()),'real message decision returns to unresolved');
END $message$;
\endif

SET LOCAL enable_seqscan=off;
DO $plan$
DECLARE query text; plan json;
BEGIN
 FOREACH query IN ARRAY ARRAY[
   'SELECT org_id FROM public.users WHERE id=''03040000-0000-4000-8000-000000000001''',
   'SELECT id FROM public.job_cost_lines WHERE document_kind=''xero_bill'' AND document_id=''ZZTEST-0304-bare''',
   'SELECT id FROM public.reconcile_decisions WHERE subject_kind=''cost_document'' AND subject_id=''xero_bill:ZZTEST-0304-bare'' ORDER BY decided_at DESC,id DESC LIMIT 1',
   'SELECT id FROM public.reconcile_items WHERE status=''open'' AND subject_table=''cost_document'' AND subject_id=''xero_bill:ZZTEST-0304-bare''',
   'SELECT id FROM public.match_clues WHERE current AND subject_kind=''cost_document'' AND subject_id=''xero_bill:ZZTEST-0304-bare'''] LOOP
   EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) '||query INTO plan;
   PERFORM pg_temp.check_it(plan::text !~ 'Seq Scan' AND plan::text ~ '(Index Scan|Index Only Scan|Bitmap Index Scan)','indexed subject or id read');
 END LOOP;
END $plan$;

SELECT pg_temp.check_it(has_function_privilege('service_role','public.reconcile_undo(bigint,uuid)','execute')
 AND NOT has_function_privilege('authenticated','public.reconcile_undo(bigint,uuid)','execute')
 AND NOT has_function_privilege('anon','public.reconcile_undo(bigint,uuid)','execute'),'service-only rpc');
SET CONSTRAINTS ALL IMMEDIATE;
\ir ../../../rollbacks/20261118195300_reconcile_undo_down.sql
SELECT pg_temp.check_it(to_regprocedure('public.reconcile_undo(bigint,uuid)') IS NULL
 AND (SELECT md5(prosrc)='e5382283d43345f54b314a6fdf6fc897' FROM pg_proc WHERE oid='public.match_apply_stop(text)'::regprocedure)
 AND (SELECT md5(prosrc)='2d37c485e29e0a9a1a2b59985417741f' FROM pg_proc WHERE
 oid='public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure),'rollback restores parent bodies');
SELECT 'PASS P2-03.4: '||count(*)||' checks' FROM undo_checks;
ROLLBACK;
