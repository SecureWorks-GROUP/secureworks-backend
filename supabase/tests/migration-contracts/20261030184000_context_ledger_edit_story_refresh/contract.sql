\set ON_ERROR_STOP on
\if :{?expect_legacy}
\else
\set expect_legacy false
\endif
BEGIN;
SELECT set_config('test.ledger_edit_legacy', :'expect_legacy', true);
CREATE TEMP TABLE edit_checks(name text,passed boolean);
CREATE FUNCTION pg_temp.edit_assert(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'ledger edit story contract: %',n;END IF;
 INSERT INTO edit_checks VALUES(n,p);
END $$;
DO $test$
DECLARE j uuid;g uuid;retired uuid;staff uuid:=gen_random_uuid();w jsonb;r jsonb;edit jsonb;k integer;key text;
 expected boolean;legacy boolean:=current_setting('test.ledger_edit_legacy')::boolean;written timestamptz;
BEGIN
 UPDATE automation_switches SET all_stop=false,extraction=true WHERE id=1;
 UPDATE feature_flags SET enabled=true WHERE flag_name='context_job_story_text_v1';
 INSERT INTO users(id,org_id,name,role,trade_sees_all_jobs) VALUES(staff,'00000000-0000-0000-0000-000000000001','Synthetic note editor','admin',false);
 FOR k IN 1..10 LOOP
  j:=gen_random_uuid();g:=gen_random_uuid();written:=now()-interval '1 hour';expected:=k<=4 AND NOT legacy;
  IF k=7 THEN written:=now()-interval '5 minutes';END IF;
  INSERT INTO jobs(id,org_id,status,type,job_number,client_name,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','in_progress','fencing','SWF-EDIT-'||k,'Synthetic note job','{}','2026-09-01');
  INSERT INTO context_ledger_generations(id,job_id,kind,status,reader,promoted_at,evidence_until,checks)
  VALUES(g,j,'backfill','live','luna-ledger:v8-finance1',now()-interval '2 hours',now()-interval '2 hours','{}');
  edit:=context_ledger_person_edit(j,staff,'add',NULL,'Call before arriving.','{"item_type":"request","status":"open","from_role":"customer","to_role":"us","what":"Call before arriving","about_key":"access:call-ahead"}');
  PERFORM pg_temp.edit_assert('setup accepted',edit->>'outcome'='edited');key:=edit->>'item_key';
  IF k=3 THEN PERFORM context_ledger_person_edit(j,staff,'close',key,'Earlier fixture answer.');END IF;
  UPDATE context_ledger_items SET created_at=now()-interval '2 hours',updated_at=now()-interval '2 hours' WHERE generation_id=g;
  w:=context_job_story_writer_input(j);
  INSERT INTO context_job_story_texts(job_id,checked_at,job_status,card_hash,record_sig,generation_id,evidence_until,model,sections,checks,written_at)
  VALUES(j,now()-interval '1 hour','in_progress',w->>'card_hash',context_job_story_record_sig(j),g,now()-interval '2 hours','fixture-model',
   '{"headline":"Fixture job.","the_job":"Fixture fence.","how_we_got_here":"Fixture preparation.","where_it_is_at":"Awaiting work.","watch_out":"Costs unknown."}',
   jsonb_build_object('writer','fixture-edit','money_sig',context_job_story_money_sig(j)),written);
  IF k IN(1,7,8,9,10) THEN edit:=context_ledger_person_edit(j,staff,'add',NULL,'Send the promised document.','{"item_type":"request","status":"open","from_role":"customer","to_role":"us","what":"Send the promised document","about_key":"other:promised-document"}');
  ELSIF k=2 THEN edit:=context_ledger_person_edit(j,staff,'close',key,'Fixture answer confirmed.');
  ELSIF k=3 THEN edit:=context_ledger_person_edit(j,staff,'reopen',key,'Fixture answer was incomplete.');
  ELSIF k=4 THEN edit:=context_ledger_person_edit(j,staff,'dispute',key,'Fixture accounts disagree.');
  ELSIF k=6 THEN
   retired:=gen_random_uuid();INSERT INTO context_ledger_generations(id,job_id,kind,status,reader) VALUES(retired,j,'backfill','retired','fixture/old');
   INSERT INTO context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,to_role,what,opened_at,opened_by,written_by,closes_on)
    VALUES(retired,j,'old:note','request','open','customer','us','An old generation note.',now(),jsonb_build_array(jsonb_build_object('table','person','id',staff,'excerpt','An old generation note.')),'model:fixture','reply');
  END IF;
  IF k IN(1,2,3,4,7,8,9,10) THEN PERFORM pg_temp.edit_assert('case '||k||' actual edit accepted: '||edit::text,edit->>'outcome'='edited');END IF;
  IF k=8 THEN UPDATE feature_flags SET enabled=false WHERE flag_name='context_job_story_text_v1';END IF;
  IF k=9 THEN INSERT INTO context_job_story_requests(job_id,requested_by,reason,done_at,outcome,error) VALUES(j,'fixture','asked',now(),'failed','fact_check_failed');END IF;
  IF k=10 THEN INSERT INTO context_job_story_requests(job_id,requested_by,reason) VALUES(j,'fixture','asked');END IF;
  r:=context_job_story_enqueue_changed(5);
  PERFORM pg_temp.edit_assert(CASE WHEN k=1 THEN 'staff edit never queues' ELSE 'case '||k||' queue decision' END,(coalesce(r->'job_ids','[]') @> jsonb_build_array(j))=expected);
  IF expected THEN
   PERFORM context_job_story_enqueue_changed(5);
   PERFORM pg_temp.edit_assert('case '||k||' no duplicate',(SELECT count(*) FROM context_job_story_requests WHERE job_id=j AND done_at IS NULL)=1);
  END IF;
  IF k=8 THEN UPDATE feature_flags SET enabled=true WHERE flag_name='context_job_story_text_v1';END IF;
 END LOOP;
 PERFORM pg_temp.edit_assert('service role only',has_function_privilege('service_role','context_job_story_enqueue_changed(integer)','EXECUTE') AND NOT has_function_privilege('anon','context_job_story_enqueue_changed(integer)','EXECUTE') AND NOT has_function_privilege('authenticated','context_job_story_enqueue_changed(integer)','EXECUTE'));
END $test$;
SELECT count(*) AS assertions FROM edit_checks;
ROLLBACK;
