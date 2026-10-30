\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE witness_checks(name text,passed boolean);
CREATE FUNCTION pg_temp.witness_assert(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'story ledger witness contract: %',n;END IF;
 INSERT INTO witness_checks VALUES(n,p);
END $$;
DO $test$
DECLARE j uuid:=gen_random_uuid();g uuid:=gen_random_uuid();staff uuid:=gen_random_uuid();q uuid;token uuid;
 w jsonb;r jsonb;edit jsonb;sig text;fin text;key text;old_id uuid;new_id uuid;claim jsonb;
 sections jsonb:='{"headline":"Fixture job.","the_job":"Fixture fence.","how_we_got_here":"Fixture preparation.","where_it_is_at":"Awaiting work.","watch_out":"Costs unknown."}';
BEGIN
 UPDATE automation_switches SET all_stop=false,extraction=true WHERE id=1;
 UPDATE feature_flags SET enabled=true WHERE flag_name='context_job_story_text_v1';
 INSERT INTO users(id,org_id,name,role,trade_sees_all_jobs) VALUES(staff,'00000000-0000-0000-0000-000000000001','Synthetic witness editor','admin',false);
 INSERT INTO jobs(id,org_id,status,type,job_number,client_name,metadata,created_at)
 VALUES(j,'00000000-0000-0000-0000-000000000001','in_progress','fencing','SWF-WITNESS','Synthetic witness job','{}','2026-09-01');
 INSERT INTO context_ledger_generations(id,job_id,kind,status,reader,promoted_at,evidence_until,checks)
 VALUES(g,j,'backfill','live','luna-ledger:v8-finance1',now()-interval '2 hours',now()-interval '2 hours','{}');
 edit:=context_ledger_person_edit(j,staff,'add',NULL,'Call before arriving.','{"item_type":"request","status":"open","from_role":"customer","to_role":"us","what":"Call before arriving","about_key":"access:call-ahead"}');
 PERFORM pg_temp.witness_assert('actual staff add accepted',edit->>'outcome'='edited');key:=edit->>'item_key';
 sig:=context_job_story_ledger_sig(j);fin:=context_ledger_record_signature(j);
 PERFORM pg_temp.witness_assert('content witness exists',sig ~ '^[0-9a-f]{32}$');
 PERFORM set_config('TimeZone','UTC',true);
 PERFORM pg_temp.witness_assert('UTC stable',sig=context_job_story_ledger_sig(j));
 PERFORM set_config('TimeZone','America/New_York',true);
 PERFORM pg_temp.witness_assert('New York stable',sig=context_job_story_ledger_sig(j));
 UPDATE context_ledger_items SET created_at=now()-interval '2 hours',updated_at=now()-interval '2 hours' WHERE generation_id=g;
 PERFORM pg_temp.witness_assert('touch times not content',sig=context_job_story_ledger_sig(j));
 w:=context_job_story_writer_input(j);
 INSERT INTO context_job_story_texts(job_id,checked_at,job_status,card_hash,record_sig,generation_id,evidence_until,model,sections,checks,written_at)
 VALUES(j,now()-interval '1 hour','in_progress',w->>'card_hash',context_job_story_record_sig(j),g,now()-interval '2 hours','fixture-model',sections,
  jsonb_build_object('writer','fixture-witness','money_sig',context_job_story_money_sig(j),'ledger_sig',sig),now()-interval '1 hour') RETURNING id INTO old_id;
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('unchanged does not queue',NOT(r->'job_ids' @> jsonb_build_array(j)));
 -- Same generation correction with a timestamp OLDER than checked_at must still queue.
 edit:=context_ledger_person_edit(j,staff,'add',NULL,'Send the promised document.','{"item_type":"request","status":"open","from_role":"customer","to_role":"us","what":"Send the promised document","about_key":"other:promised-document"}');
 UPDATE context_ledger_items SET created_at=now()-interval '2 hours',updated_at=now()-interval '2 hours' WHERE generation_id=g;
 PERFORM pg_temp.witness_assert('financial reader signature unchanged',fin=context_ledger_record_signature(j));
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('older timestamp correction queues',r->'job_ids' @> jsonb_build_array(j));
 PERFORM context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('no duplicate',(SELECT count(*) FROM context_job_story_requests WHERE job_id=j AND done_at IS NULL)=1);
 SELECT id INTO q FROM context_job_story_requests WHERE job_id=j AND done_at IS NULL;
 token:=gen_random_uuid();claim:=context_job_story_claim_state(j);
 UPDATE context_job_story_requests SET picked_at=now(),lease_token=token,lease_expires_at=now()+interval '5 minutes',claimed_state=claim WHERE id=q;
 PERFORM pg_temp.witness_assert('claim contains source witness',claim->>'ledger_sig'=context_job_story_ledger_sig(j));
 -- Correction after claim. Unchanged finish may only cover the claimed contents.
 PERFORM context_ledger_person_edit(j,staff,'dispute',key,'Fixture access account disputed.');
 UPDATE context_ledger_items SET created_at=now()-interval '2 hours',updated_at=now()-interval '2 hours' WHERE generation_id=g;
 r:=context_job_story_request_finish(q,token,'unchanged');
 PERFORM pg_temp.witness_assert('unchanged finished',r->>'closed_as'='unchanged');
 PERFORM pg_temp.witness_assert('unchanged preserves claimed witness',(SELECT checks->>'ledger_sig' FROM context_job_story_texts WHERE id=old_id)=claim->>'ledger_sig');
 PERFORM pg_temp.witness_assert('later correction not acknowledged',(SELECT checks->>'ledger_sig' FROM context_job_story_texts WHERE id=old_id)<>context_job_story_ledger_sig(j));
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('late unchanged correction queues',r->'job_ids' @> jsonb_build_array(j));
 SELECT id INTO q FROM context_job_story_requests WHERE job_id=j AND done_at IS NULL;
 token:=gen_random_uuid();claim:=context_job_story_claim_state(j);w:=context_job_story_writer_input(j);
 UPDATE context_job_story_requests SET picked_at=now(),lease_token=token,lease_expires_at=now()+interval '5 minutes',claimed_state=claim WHERE id=q;
 PERFORM context_ledger_person_edit(j,staff,'close',key,'Fixture confirmed resolution.');
 UPDATE context_ledger_items SET created_at=now()-interval '2 hours',updated_at=now()-interval '2 hours' WHERE generation_id=g;
 r:=context_job_story_text_save(q,token,j,sections,w->>'card_hash',NULL,NULL,'fixture-model',NULL,
  jsonb_build_object('money_sig',context_job_story_money_sig(j),'ledger_sig',context_job_story_ledger_sig(j)));
 PERFORM pg_temp.witness_assert('actual save accepted',r->>'outcome'='saved');new_id:=(r->>'text_id')::uuid;
 PERFORM pg_temp.witness_assert('caller cannot forge later witness',(SELECT checks->>'ledger_sig' FROM context_job_story_texts WHERE id=new_id)=claim->>'ledger_sig');
 PERFORM pg_temp.witness_assert('old story superseded',(SELECT status FROM context_job_story_texts WHERE id=old_id)='superseded');
 r:=context_job_story_text_save(q,token,j,sections,w->>'card_hash',NULL,NULL,'fixture-model',NULL,'{}');
 PERFORM pg_temp.witness_assert('duplicate save loses lease',r->>'outcome'='lease_lost');
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('rewrite floor retained',NOT(r->'job_ids' @> jsonb_build_array(j)));
 UPDATE context_job_story_texts SET written_at=now()-interval '1 hour' WHERE id=new_id;
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('late saved correction queues',r->'job_ids' @> jsonb_build_array(j));
 UPDATE context_job_story_requests SET done_at=now(),outcome='unchanged' WHERE job_id=j AND done_at IS NULL;
 UPDATE context_job_story_texts SET checks=checks||jsonb_build_object('ledger_sig',context_job_story_ledger_sig(j)) WHERE id=new_id;
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('covered contents idle',NOT(r->'job_ids' @> jsonb_build_array(j)));
 -- Retired generation edits cannot invalidate the current witness.
 sig:=context_job_story_ledger_sig(j);
 INSERT INTO context_ledger_generations(id,job_id,kind,status,reader) VALUES(gen_random_uuid(),j,'backfill','retired','fixture/old');
 PERFORM pg_temp.witness_assert('retired generation ignored',sig=context_job_story_ledger_sig(j));
 -- Missing legacy witness is bounded by the same backfill allowance.
 UPDATE context_job_story_texts SET checks=checks-'ledger_sig' WHERE id=new_id;
 WITH js AS (INSERT INTO jobs(id,org_id,status,type,job_number,client_name,metadata,created_at)
  SELECT gen_random_uuid(),'00000000-0000-0000-0000-000000000001','in_progress','fencing','SWF-WITNESS-BACKFILL-'||n,'Synthetic capacity job','{}','2026-09-01' FROM generate_series(1,10) n RETURNING id)
 INSERT INTO context_job_story_requests(job_id,requested_by,reason) SELECT id,'fixture','asked' FROM js;
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('missing witness backfill bounded',NOT(r->'job_ids' @> jsonb_build_array(j)));
 DELETE FROM context_job_story_requests WHERE requested_by='fixture' AND job_id<>j;
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('missing witness queues with capacity',r->'job_ids' @> jsonb_build_array(j));
 SELECT id INTO q FROM context_job_story_requests WHERE job_id=j AND done_at IS NULL;
 token:=gen_random_uuid();claim:=context_job_story_claim_state(j);
 UPDATE context_job_story_requests SET picked_at=now(),lease_token=token,lease_expires_at=now()+interval '5 minutes',claimed_state=claim WHERE id=q;
 PERFORM context_job_story_request_finish(q,token,'unchanged');
 PERFORM pg_temp.witness_assert('unchanged backfills trusted witness',(SELECT checks->>'ledger_sig' FROM context_job_story_texts WHERE id=new_id)=claim->>'ledger_sig');
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('backfill not endless',NOT(r->'job_ids' @> jsonb_build_array(j)));
 -- Extra checks on the current implementation, not a rolled-back historical version.
 UPDATE context_job_story_texts SET checks=checks||jsonb_build_object('ledger_sig',md5('older-content')) WHERE id=new_id;
 UPDATE feature_flags SET enabled=false WHERE flag_name='context_job_story_text_v1';
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('off remains off',r->>'outcome'='off' AND (r->>'queued')::int=0);
 UPDATE feature_flags SET enabled=true WHERE flag_name='context_job_story_text_v1';
 r:=context_job_story_enqueue_changed(0);
 PERFORM pg_temp.witness_assert('zero limit remains zero',(r->>'queued')::int=0);
 INSERT INTO context_job_story_requests(job_id,requested_by,reason,done_at,outcome,error) VALUES(j,'fixture','asked',now(),'failed','fact_check_failed');
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('new failure still delays correction',NOT(r->'job_ids' @> jsonb_build_array(j)));
 DELETE FROM context_job_story_requests WHERE job_id=j AND outcome='failed';
 r:=context_job_story_enqueue_changed(5);
 PERFORM pg_temp.witness_assert('change resumes when failure removed in fixture',r->'job_ids' @> jsonb_build_array(j));
 SELECT id INTO q FROM context_job_story_requests WHERE job_id=j AND done_at IS NULL;
 token:=gen_random_uuid();claim:=context_job_story_claim_state(j)-'ledger_sig';
 UPDATE context_job_story_requests SET picked_at=now(),lease_token=token,lease_expires_at=now()+interval '5 minutes',claimed_state=claim WHERE id=q;
 r:=context_job_story_text_save(q,token,j,sections,w->>'card_hash',NULL,NULL,'fixture-model',NULL,'[]');
 PERFORM pg_temp.witness_assert('invalid checks remain refused',r->>'reason'='checks_invalid');
 r:=context_job_story_text_save(q,token,j,sections,w->>'card_hash',NULL,NULL,'fixture-model',NULL,jsonb_build_object('ledger_sig',context_job_story_ledger_sig(j)));
 PERFORM pg_temp.witness_assert('legacy claim save works',r->>'outcome'='saved');
 PERFORM pg_temp.witness_assert('legacy claim cannot forge witness',NOT(SELECT checks ? 'ledger_sig' FROM context_job_story_texts WHERE id=(r->>'text_id')::uuid));
 PERFORM pg_temp.witness_assert('service role only',has_function_privilege('service_role','context_job_story_ledger_sig(uuid)','EXECUTE') AND NOT has_function_privilege('anon','context_job_story_ledger_sig(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','context_job_story_ledger_sig(uuid)','EXECUTE'));
 PERFORM pg_temp.witness_assert('fixed definer path',EXISTS(SELECT 1 FROM pg_proc WHERE oid='context_job_story_ledger_sig(uuid)'::regprocedure AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']));
END $test$;
SELECT count(*) AS assertions FROM witness_checks;
ROLLBACK;
\ir ../../../migrations/20261030185500_context_story_ledger_witness.sql
