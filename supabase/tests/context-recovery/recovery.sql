\set ON_ERROR_STOP on
BEGIN;
SET LOCAL timezone='UTC';
\ir ../../../scripts/context-recover-rebuild-items.sql
CREATE TEMP TABLE recovery_checks(name text,passed boolean);
CREATE FUNCTION pg_temp.prove(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'recovery test: %',n; END IF;
 INSERT INTO recovery_checks VALUES(n,p);
END $$;
CREATE FUNCTION pg_temp.fixture(k integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); inv uuid:=gen_random_uuid();
 src uuid:=gen_random_uuid(); live uuid:=gen_random_uuid(); target uuid:=gen_random_uuid(); run uuid:=gen_random_uuid(); lease uuid:=gen_random_uuid();
 request jsonb; number text:='INV-RCV-'||k;
BEGIN
 UPDATE automation_switches SET extraction=true,all_stop=false WHERE id=1;
 UPDATE context_ledger_settings SET mode='live',reader='luna-ledger:v8-finance1' WHERE id;
 INSERT INTO jobs(id,org_id,status,type,job_number,client_name,site_suburb,metadata,created_at)
 VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-RCV-'||k,'Fixture Customer','Testville','{}','2026-09-01');
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO business_events(id,job_id,event_type,source,channel,direction,payload,metadata,occurred_at,event_at,recorded_at,context_captured_at,attribution_status,attribution_step,attribution_confidence,attributed_at,match_method)
 SELECT id,j,'client.reply','recovery_contract','sms','outbound',jsonb_build_object('body',words),
 '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","sender_role":"staff","recipient_role":"customer","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
 '2026-09-02','2026-09-02','2026-09-02','2026-09-02','direct',1,1,'2026-09-02','direct_job_id'
 FROM (VALUES(e,'Invoice recipient names conflict.'),(c,'Please pay this invoice and confirm when payment is complete.')) v(id,words);
 PERFORM set_config('session_replication_role','origin',true);
 INSERT INTO xero_invoices(id,org_id,xero_invoice_id,invoice_type,job_id,invoice_number,status,invoice_date,total,amount_due,amount_paid,fully_paid_on,created_at,updated_at)
 VALUES(inv,'00000000-0000-0000-0000-000000000001',gen_random_uuid(),'ACCREC',j,number,'PAID','2026-09-01',100,0,100,'2026-09-05','2026-09-01','2026-09-05');
 INSERT INTO context_extraction_runs(id,job_id,run_date,phase,status,lease_token,lease_expires_at,run_seq)
 VALUES(run,j,current_date,'ledger','running',lease,now()+interval '15 minutes',1);
 INSERT INTO context_ledger_generations(id,job_id,kind,status,reader,promoted_at,evidence_until,run_id)
 VALUES(src,j,'backfill','retired','luna-ledger:v8',now()-interval '2 days',now()-interval '2 days',NULL),
 (live,j,'rebuild','live','luna-ledger:v8',now()-interval '1 day',now()-interval '1 day',NULL),
 (target,j,'rebuild','building','luna-ledger:v8-finance1',NULL,NULL,run);
 INSERT INTO context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,to_role,what,about_key,opened_at,opened_by,closes_on,needs_reply,written_by,person_locked,closed_at,closed_by)
 SELECT gen,j,key,kind,status,'us','customer',words,'invoice:'||lower(number),'2026-09-02',
 jsonb_build_array(jsonb_build_object('table','business_events','id',event,'excerpt',words)),closes,needs,'model:luna-ledger:v8',false,
 CASE WHEN status='closed' THEN '2026-09-05'::timestamptz END,
 CASE WHEN status='closed' THEN jsonb_build_array(jsonb_build_object('table','xero_invoices','id',inv,'excerpt','Paid invoice')) END
 FROM (VALUES(src,'issue:recipient','issue','open','Invoice recipient names conflict.',e,'record',false),
 (src,'request:confirmation','request','open','Please pay this invoice and confirm when payment is complete.',c,'reply',true),
 (src,'request:oldpayment','request','open','Please pay this invoice and confirm when payment is complete.',c,'payment',false),
 (live,'request:replacementpayment','request','closed','Please pay this invoice and confirm when payment is complete.',c,'payment',false)) v(gen,key,kind,status,words,event,closes,needs);
 SELECT jsonb_build_object('run_id',run,'lease_token',lease,'source_generation_id',src,'expected_live_generation_id',live,
  'items',jsonb_agg(jsonb_build_object('key',i.item_key,'row_md5',md5(to_jsonb(i)::text)) ORDER BY i.item_key)) INTO request
 FROM context_ledger_items i WHERE generation_id=src AND item_key IN ('issue:recipient','request:confirmation');
 RETURN jsonb_build_object('request',request,'job',j,'source',src,'live',live,'target',target,'event',e,'invoice',inv);
END $$;
DO $test$
DECLARE f jsonb; request jsonb; result jsonb; packet jsonb; before_live jsonb; meta jsonb; case_no integer; expected text; got text; reply uuid;
BEGIN
 FOR case_no IN 1..13 LOOP
  f:=pg_temp.fixture(case_no);request:=f->'request';expected:=NULL;
  SELECT jsonb_agg(to_jsonb(i) ORDER BY item_key) INTO before_live FROM context_ledger_items i WHERE generation_id=(f->>'live')::uuid;
  CASE case_no
   WHEN 2 THEN request:=jsonb_set(request,'{lease_token}',to_jsonb(gen_random_uuid()));expected:='context_recovery_lease_lost';
   WHEN 3 THEN request:=jsonb_set(request,'{expected_live_generation_id}',to_jsonb(gen_random_uuid()));expected:='context_recovery_live_generation_changed';
   WHEN 4 THEN UPDATE context_ledger_items SET what=what||' amended' WHERE generation_id=(f->>'source')::uuid AND item_key='issue:recipient';expected:='context_recovery_source_changed';
   WHEN 5 THEN
    PERFORM set_config('session_replication_role','replica',true);UPDATE business_events SET job_id=NULL WHERE id=(f->>'event')::uuid;PERFORM set_config('session_replication_role','origin',true);expected:='context_recovery_source_not_currently_placed';
   WHEN 6 THEN UPDATE context_ledger_items SET person_locked=true WHERE generation_id=(f->>'live')::uuid;expected:='context_recovery_later_decision_or_duplicate';
   WHEN 7 THEN UPDATE context_ledger_items SET supersedes_key='request:confirmation' WHERE generation_id=(f->>'live')::uuid;expected:='context_recovery_later_decision_or_duplicate';
   WHEN 8 THEN UPDATE context_ledger_items SET closes_on='reply' WHERE generation_id=(f->>'live')::uuid;expected:='context_recovery_later_decision_or_duplicate';
   WHEN 9 THEN
    SELECT jsonb_set(request,'{items}',jsonb_build_array(jsonb_build_object('key',i.item_key,'row_md5',md5(to_jsonb(i)::text)))) INTO request FROM context_ledger_items i WHERE generation_id=(f->>'source')::uuid AND item_key='request:oldpayment';expected:='context_recovery_not_unresolved_nonpayment';
   ELSE NULL;
  END CASE;
  IF expected IS NOT NULL THEN
   got:=NULL;
   BEGIN PERFORM pg_temp.context_recover_rebuild_items(request);EXCEPTION WHEN OTHERS THEN got:=SQLERRM;END;
   PERFORM pg_temp.prove('case '||case_no||' refuses '||expected,got LIKE expected||'%');
   PERFORM pg_temp.prove('case '||case_no||' atomically leaves no recovered rows',NOT EXISTS(SELECT 1 FROM context_ledger_items WHERE generation_id=(f->>'target')::uuid));
   CONTINUE;
  END IF;
  result:=pg_temp.context_recover_rebuild_items(request);
  PERFORM pg_temp.prove('case '||case_no||' recovers exactly two distinct matters',(result->>'historical_recovery_copied')::integer=2 AND jsonb_array_length(result->'open_items')=2);
  PERFORM pg_temp.prove('case '||case_no||' live generation and closed payment unchanged',before_live=(SELECT jsonb_agg(to_jsonb(i) ORDER BY item_key) FROM context_ledger_items i WHERE generation_id=(f->>'live')::uuid));
  IF case_no=10 THEN
   request:=jsonb_set(request,'{items,0,row_md5}',to_jsonb(repeat('0',32)));got:=NULL;
   BEGIN PERFORM pg_temp.context_recover_rebuild_items(request);EXCEPTION WHEN OTHERS THEN got:=SQLERRM;END;
   PERFORM pg_temp.prove('changed retry manifest refused',got='context_recovery_manifest_changed');CONTINUE;
  END IF;
  meta:=jsonb_build_object('model','fixture/no-model','prompt_sha256',repeat('a',64),'evidence_until',now(),'evidence_rows',2,'chunks',1,'calls',0,'tokens_in',0,
   'checks',jsonb_build_object('validator','ok','proposed',0,'refused_local',0,'financial_signature',context_ledger_record_signature((f->>'job')::uuid)));
  IF case_no=11 THEN UPDATE context_ledger_items SET person_locked=true WHERE generation_id=(f->>'live')::uuid;expected:='context_recovery_later_decision_or_duplicate';END IF;
  IF case_no=12 THEN UPDATE xero_invoices SET amount_due=20,status='AUTHORISED',fully_paid_on=NULL WHERE id=(f->>'invoice')::uuid;expected:='context_recovery_financial_snapshot_changed';END IF;
  IF case_no=13 THEN
   reply:=gen_random_uuid();
   PERFORM set_config('session_replication_role','replica',true);
   INSERT INTO business_events(id,job_id,event_type,source,channel,direction,payload,metadata,occurred_at,event_at,recorded_at,context_captured_at,attribution_status,attribution_step,attribution_confidence,attributed_at,match_method)
   VALUES(reply,(f->>'job')::uuid,'client.reply','recovery_contract','sms','inbound','{"body":"Payment is complete, thank you."}',
   '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
   '2026-09-03','2026-09-03','2026-09-03','2026-09-03','direct',1,1,'2026-09-03','direct_job_id');
   PERFORM set_config('session_replication_role','origin',true);
   result:=context_ledger_write((request->>'run_id')::uuid,(request->>'lease_token')::uuid,(f->>'target')::uuid,'[]',
    jsonb_build_array(jsonb_build_object('item_key','request:confirmation','to_status','closed','reason','Customer confirmed payment',
     'evidence',jsonb_build_array(jsonb_build_object('table','business_events','id',reply,'excerpt','Payment is complete, thank you.')))),'luna-ledger:v8-finance1');
   PERFORM pg_temp.prove('normal writer accepts actual new reply proof',(result->>'transitions_accepted')::integer=1);
   packet:=pg_temp.context_recover_rebuild_items(request);
   PERFORM pg_temp.prove('retry after closure never reseeds',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(packet->'open_items') i WHERE i->>'item_key'='request:confirmation'));
   CONTINUE;
  END IF;
  IF expected IS NOT NULL THEN
   got:=NULL;BEGIN PERFORM pg_temp.context_recover_rebuild_finish(request,meta);EXCEPTION WHEN OTHERS THEN got:=SQLERRM;END;
   PERFORM pg_temp.prove('case '||case_no||' rechecks before finish',got LIKE expected||'%');
   PERFORM pg_temp.prove('case '||case_no||' cannot promote after concurrent change',context_ledger_current_generation((f->>'job')::uuid)=(f->>'live')::uuid);CONTINUE;
  END IF;
  packet:=pg_temp.context_recover_rebuild_items(request);
  PERFORM pg_temp.prove('identical retry does not duplicate',packet->'historical_recovery_replayed'='true' AND (SELECT count(*) FROM context_ledger_transitions WHERE generation_id=(f->>'target')::uuid AND by='rule:historical_recovery')=2);
  result:=pg_temp.context_recover_rebuild_finish(request,meta);
  PERFORM pg_temp.prove('normal guarded finish promotes synthetic recovery',result->'promoted'='true' AND context_ledger_current_generation((f->>'job')::uuid)=(f->>'target')::uuid);
  PERFORM pg_temp.prove('recovery provenance survives normal finish',EXISTS(SELECT 1 FROM context_ledger_generations WHERE id=(f->>'target')::uuid AND checks#>>'{reader,historical_recovery,source_generation_id}'=f->>'source'));
  packet:=context_job_story_ledger((f->>'job')::uuid);
  PERFORM pg_temp.prove('served notes preserve confirmation and dispute with current paid source',jsonb_array_length(packet->'items')=2 AND EXISTS(SELECT 1 FROM jsonb_array_elements(packet->'items') i WHERE i->>'item_key'='request:confirmation' AND i->>'closes_on'='reply' AND i->>'status'='open') AND packet::text LIKE '%PAID; owing $0.00%');
 END LOOP;
END $test$;
SELECT jsonb_build_object('checked_at',now(),'checks',jsonb_agg(to_jsonb(recovery_checks)),'scope','13 synthetic recovery scenarios; real SQL preparation/finish/store. Zero production, model or provider calls.') FROM recovery_checks;
ROLLBACK;
