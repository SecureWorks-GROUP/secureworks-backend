-- Development fixtures only. Original provider-copy RPC, scheduler and reader decision.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE credit_checks(name text, passed boolean);
CREATE FUNCTION pg_temp.prove(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'credit freshness: %',n;END IF;
 INSERT INTO credit_checks VALUES(n,p);
END $$;
DO $test$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001';
 j uuid:=gen_random_uuid();j2 uuid:=gen_random_uuid();otherj uuid:=gen_random_uuid();g uuid:=gen_random_uuid();
 bill text:=gen_random_uuid()::text;bill2 text:=gen_random_uuid()::text;cn text:=gen_random_uuid()::text;
 n jsonb;a jsonb;s0 text;s1 text;s2 text;r0 text;other0 text;w jsonb;d jsonb;cost0 numeric;
BEGIN
 INSERT INTO organisations(id,name) VALUES(org,'Synthetic credit organisation') ON CONFLICT(id) DO NOTHING;
 UPDATE automation_switches SET all_stop=false,extraction=true WHERE id=1;
 INSERT INTO feature_flags(flag_name,enabled) VALUES('context_ledger_financial_refresh_v1',true),('context_job_story_text_v1',true)
 ON CONFLICT(flag_name) DO UPDATE SET enabled=excluded.enabled;
 UPDATE context_ledger_settings SET mode='live',reader='luna-ledger:v8',job_ids=ARRAY[j,j2],backfill_from_hour=NULL,backfill_to_hour=NULL WHERE id;
 INSERT INTO jobs(id,org_id,status,type,job_number,client_name,metadata,created_at) VALUES
 (j,org,'in_progress','fencing','SWF-CREDIT-1','Synthetic credit fixture','{}','2026-09-01'),
 (j2,org,'in_progress','patio','SWP-CREDIT-2','Synthetic split fixture','{}','2026-09-01'),
 (otherj,org,'in_progress','fencing','SWF-CREDIT-CONTROL','Synthetic control','{}','2026-09-01');
 INSERT INTO xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,sub_total,total,invoice_date,line_items,raw_json,job_id) VALUES
 (org,bill,'CREDIT-BILL','ACCPAY','AUTHORISED',1000,1100,'2026-10-01','[{"Description":"Steel","AccountCode":"310","LineAmount":1000}]','{"Total":1100}',j),
 (org,bill2,'CREDIT-BILL-2','ACCPAY','AUTHORISED',1000,1100,'2026-10-01','[{"Description":"Roof","AccountCode":"310","LineAmount":1000}]','{"Total":1100}',j2);
 s0:=context_job_story_money_sig(j);other0:=context_job_story_money_sig(otherj);
 SELECT actual_cost_ex INTO cost0 FROM v_job_profit WHERE job_id=j;
 PERFORM pg_temp.prove('no linked note has no invented witness',context_job_story_credit_sig(j) IS NULL);
 n:=jsonb_build_object('xero_credit_note_id',cn,'credit_note_type','ACCPAYCREDIT','credit_note_number','CREDIT-1','status','AUTHORISED','currency_code','AUD',
 'credit_note_date','2026-10-02','sub_total',100,'total_tax',10,'total',110,'remaining_credit',55,'xero_updated_at','2026-10-02T00:00:00Z','raw_json','{}'::jsonb);
 a:=jsonb_build_array(jsonb_build_object('xero_invoice_id',bill,'amount',55,'allocation_date','2026-10-02','is_deleted',false));
 PERFORM xero_supplier_credit_note_copy(org,n,a);
 s1:=context_job_story_money_sig(j);
 PERFORM pg_temp.prove('original copy RPC moves story signature',s1<>s0);
 PERFORM pg_temp.prove('unrelated job unchanged',context_job_story_money_sig(otherj)=other0);
 PERFORM pg_temp.prove('freshness migration does not invent netting',(SELECT actual_cost_ex FROM v_job_profit WHERE job_id=j)=cost0);
 -- Source clock touches must not keep a reader in a permanent refresh loop.
 PERFORM xero_supplier_credit_note_copy(org,n||'{"xero_updated_at":"2026-10-02T01:00:00Z"}',a);
 PERFORM pg_temp.prove('identical provider reread is quiet',context_job_story_money_sig(j)=s1);
 PERFORM set_config('TimeZone','America/New_York',true);
 PERFORM pg_temp.prove('same source stable in other timezone',context_job_story_money_sig(j)=s1);
 -- Historical customer obligation provides real reader evidence; source corrections below add no messages.
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO business_events(id,job_id,event_type,source,channel,direction,payload,metadata,occurred_at,event_at,recorded_at,context_captured_at,attribution_status,attribution_step,attribution_confidence,attributed_at,match_method)
 VALUES(gen_random_uuid(),j,'client.reply','credit_contract','sms','inbound','{"body":"Please confirm the installation date and send the promised drawing."}',
 '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
 '2026-09-02','2026-09-02','2026-09-02','2026-09-02','direct',1,1,'2026-09-02','direct_job_id');
 PERFORM set_config('session_replication_role','origin',true);
 r0:=context_ledger_record_signature(j);
 INSERT INTO context_ledger_generations(id,job_id,kind,status,reader,promoted_at,evidence_until,checks)
 VALUES(g,j,'backfill','live','luna-ledger:v8',now(),(context_ledger_packet(j,NULL,now())->>'evidence_until')::timestamptz,
 jsonb_build_object('reader',jsonb_build_object('financial_signature',r0)));
 w:=context_job_story_writer_input(j);
 INSERT INTO context_job_story_texts(job_id,checked_at,job_status,card_hash,record_sig,model,sections,checks,written_at)
 VALUES(j,now()-interval '1 hour','in_progress',w->>'card_hash',context_job_story_record_sig(j),'fixture',
 '{"headline":"Fixture fence.","the_job":"Steel fence.","how_we_got_here":"Preparation.","where_it_is_at":"Waiting.","watch_out":"Costs incomplete."}',
 jsonb_build_object('writer','fixture','money_sig',s1),now()-interval '1 hour');
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('matching consumed source quiet',NOT(d->>'due')::boolean);
 a:=jsonb_build_array(jsonb_build_object('xero_invoice_id',bill,'amount',110,'allocation_date','2026-10-02','is_deleted',false));
 n:=n||'{"remaining_credit":0,"xero_updated_at":"2026-10-02T02:00:00Z"}';
 PERFORM xero_supplier_credit_note_copy(org,n,a);
 s2:=context_job_story_money_sig(j);
 PERFORM pg_temp.prove('credit-only correction moves story',s2<>s1);
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('credit-only correction requests actual reader rebuild',(d->>'due')::boolean AND d->>'kind'='rebuild' AND d->>'reason'='financial_changed');
 PERFORM pg_temp.prove('reader packet contains corrected witness',context_ledger_record_packet(j)->>'financial_signature'=context_ledger_record_signature(j));
 PERFORM pg_temp.prove('story claim contains corrected witness',context_job_story_claim_state(j)->>'money_sig'=s2);
 PERFORM context_job_story_enqueue_changed(100);
 PERFORM pg_temp.prove('correction queues actual story writer',EXISTS(SELECT 1 FROM context_job_story_requests WHERE job_id=j AND done_at IS NULL AND reason='job_changed'));
 PERFORM context_job_story_enqueue_changed(100);
 PERFORM pg_temp.prove('retry does not duplicate story request',(SELECT count(*) FROM context_job_story_requests WHERE job_id=j AND done_at IS NULL)=1);
 -- Move a credit between bills: former and receiving job both change.
 s1:=context_job_story_money_sig(j2);
 a:=jsonb_build_array(jsonb_build_object('xero_invoice_id',bill2,'amount',110,'allocation_date','2026-10-02','is_deleted',false));
 PERFORM xero_supplier_credit_note_copy(org,n||'{"xero_updated_at":"2026-10-02T03:00:00Z"}',a);
 PERFORM pg_temp.prove('former job loses credit witness',context_job_story_money_sig(j)=s0);
 PERFORM pg_temp.prove('receiving job gains credit witness',context_job_story_money_sig(j2)<>s1);
 -- A bill split must invalidate both existing placements, without moving any money.
 INSERT INTO job_materials_facts(xero_invoice_id,job_id,lane,kind,amount_ex_gst,automation_source,fact_date) VALUES
 (bill2,j,'materials','actual',600,'manual_split','2026-10-01'),(bill2,j2,'materials','actual',400,'manual_split','2026-10-01');
 s1:=context_job_story_money_sig(j);s2:=context_job_story_money_sig(j2);
 PERFORM xero_supplier_credit_note_copy(org,n||'{"xero_updated_at":"2026-10-02T04:00:00Z","credit_note_date":"2026-10-03"}',a);
 PERFORM pg_temp.prove('source-date correction reaches first split job',context_job_story_money_sig(j)<>s1);
 PERFORM pg_temp.prove('source-date correction reaches second split job',context_job_story_money_sig(j2)<>s2);
 s1:=context_job_story_money_sig(j);s2:=context_job_story_money_sig(j2);
 PERFORM xero_supplier_credit_note_copy(org,n||'{"status":"VOIDED","xero_updated_at":"2026-10-02T05:00:00Z"}',a);
 PERFORM pg_temp.prove('void removes first split witness',context_job_story_money_sig(j)<>s1 AND context_job_story_credit_sig(j) IS NULL);
 PERFORM pg_temp.prove('void removes second split witness',context_job_story_money_sig(j2)<>s2 AND context_job_story_credit_sig(j2) IS NULL);
 -- Replayed older source cannot undo the latest void or manufacture a refresh.
 s1:=context_job_story_money_sig(j);s2:=context_job_story_money_sig(j2);
 PERFORM xero_supplier_credit_note_copy(org,n,a);
 PERFORM pg_temp.prove('older provider replay cannot restore voided credit',context_job_story_money_sig(j)=s1 AND context_job_story_money_sig(j2)=s2);
 -- Different organisation data must not enter this job's witness even if a
 -- provider ID is accidentally shared in a source-copy fixture.
 INSERT INTO organisations(id,name) VALUES('00000000-0000-0000-0000-000000000099','Synthetic other organisation') ON CONFLICT(id) DO NOTHING;
 PERFORM xero_supplier_credit_note_copy('00000000-0000-0000-0000-000000000099',n,a);
 PERFORM pg_temp.prove('cross-organisation source cannot wake these jobs',context_job_story_money_sig(j)=s1 AND context_job_story_money_sig(j2)=s2);
 PERFORM pg_temp.prove('source correction does not discard customer obligation',EXISTS(SELECT 1 FROM business_events WHERE job_id=j AND payload->>'body'='Please confirm the installation date and send the promised drawing.'));
 PERFORM pg_temp.prove('correction has not fabricated a completed story',(SELECT checks->>'money_sig' FROM context_job_story_texts WHERE job_id=j ORDER BY written_at DESC LIMIT 1) IS DISTINCT FROM context_job_story_money_sig(j));
 PERFORM pg_temp.prove('no broad unrelated invalidation',context_job_story_money_sig(otherj)=other0);
 PERFORM pg_temp.prove('helper service-only',has_function_privilege('service_role','context_job_story_credit_sig(uuid)','EXECUTE') AND NOT has_function_privilege('anon','context_job_story_credit_sig(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','context_job_story_credit_sig(uuid)','EXECUTE'));
 PERFORM pg_temp.prove('definer has fixed search path',EXISTS(SELECT 1 FROM pg_proc WHERE oid='context_job_story_credit_sig(uuid)'::regprocedure AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']));
END $test$;
SELECT jsonb_build_object('checks',jsonb_agg(to_jsonb(credit_checks)),'count',count(*),'scope','self-run synthetic local SQL; no model execution or production writes') FROM credit_checks;
ROLLBACK;
