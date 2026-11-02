SELECT to_regprocedure('public.context_job_story_ledger_sig(uuid)') IS NOT NULL AS has_story_ledger_witness \gset
\if :has_story_ledger_witness
\ir ../../../rollbacks/20261030185500_context_story_ledger_witness_down.sql
\endif
\set ON_ERROR_STOP on
\if :{?expect_legacy}
\else
\set expect_legacy false
\endif
BEGIN;
SELECT set_config('test.requeue_legacy', :'expect_legacy', true);
CREATE TEMP TABLE requeue_checks(name text,passed boolean);
CREATE FUNCTION pg_temp.requeue_assert(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'story requeue contract: %',n; END IF;
 INSERT INTO requeue_checks VALUES(n,p);
END $$;
DO $proof$
DECLARE j uuid; w jsonb; r jsonb; k integer; written timestamptz; failed timestamptz; expected boolean; legacy boolean:=current_setting('test.requeue_legacy')::boolean;
BEGIN
 UPDATE automation_switches SET all_stop=false,extraction=true WHERE id=1;
 UPDATE feature_flags SET enabled=true WHERE flag_name='context_job_story_text_v1';
 FOR k IN 1..10 LOOP
  j:=gen_random_uuid(); written:=now()-interval '1 hour'; failed:=now()-interval '2 hours'; expected:=true;
  CASE k
   WHEN 1 THEN expected:=NOT legacy;
   WHEN 2 THEN failed:=now()-interval '30 minutes';expected:=false;
   WHEN 3 THEN failed:=written;expected:=false;
   WHEN 4 THEN written:=now()-interval '30 hours';failed:=now()-interval '25 hours';
   WHEN 5 THEN failed:=NULL;
   WHEN 6 THEN expected:=false;failed:=NULL;
   WHEN 7 THEN written:=now()-interval '5 minutes';expected:=false;
   WHEN 8 THEN expected:=false;
   WHEN 9 THEN expected:=false;
   WHEN 10 THEN expected:=false;
   ELSE NULL;
  END CASE;
  INSERT INTO jobs(id,org_id,status,type,job_number,client_name,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001',CASE WHEN k=10 THEN 'cancelled' ELSE 'in_progress' END,'fencing','SWF-RQ-'||k,'Synthetic requeue fixture','{}','2026-09-01');
  w:=context_job_story_writer_input(j);
  INSERT INTO context_job_story_texts(job_id,checked_at,job_status,card_hash,record_sig,model,sections,checks,written_at)
  VALUES(j,written,CASE WHEN k=10 THEN 'cancelled' ELSE 'in_progress' END,w->>'card_hash',context_job_story_record_sig(j),'fixture-model',
   '{"headline":"Fixture job.","the_job":"Fixture fence.","how_we_got_here":"Fixture preparation.","where_it_is_at":"Awaiting work.","watch_out":"Costs unknown."}',
   jsonb_build_object('writer','fixture-requeue','money_sig',CASE WHEN k=6 THEN context_job_story_money_sig(j) ELSE repeat('0',32) END),written);
  IF failed IS NOT NULL THEN
   INSERT INTO context_job_story_requests(job_id,requested_by,reason,requested_at,picked_at,done_at,outcome,error)
   VALUES(j,'fixture','asked',failed-interval '5 minutes',failed-interval '4 minutes',failed,'failed','fact_check_failed');
  END IF;
  IF k=8 THEN INSERT INTO context_job_story_requests(job_id,requested_by,reason) VALUES(j,'fixture','asked');END IF;
  IF k=9 THEN UPDATE feature_flags SET enabled=false WHERE flag_name='context_job_story_text_v1';END IF;
  r:=context_job_story_enqueue_changed(5);
  PERFORM pg_temp.requeue_assert(CASE WHEN k=1 THEN 'older failure blocks later successful story' ELSE 'case '||k||' queue decision' END,
   (coalesce(r->'job_ids','[]') @> jsonb_build_array(j))=expected);
  IF expected THEN
   PERFORM pg_temp.requeue_assert('case '||k||' ordinary job_changed request',EXISTS(SELECT 1 FROM context_job_story_requests WHERE job_id=j AND done_at IS NULL AND reason='job_changed' AND requested_by='luna-story-writer'));
   PERFORM context_job_story_enqueue_changed(5);
   PERFORM pg_temp.requeue_assert('case '||k||' repeat never duplicates',(SELECT count(*) FROM context_job_story_requests WHERE job_id=j AND done_at IS NULL)=1);
  END IF;
  IF k=9 THEN UPDATE feature_flags SET enabled=true WHERE flag_name='context_job_story_text_v1';END IF;
 END LOOP;
 PERFORM pg_temp.requeue_assert('service role only',has_function_privilege('service_role','context_job_story_enqueue_changed(integer)','EXECUTE') AND NOT has_function_privilege('anon','context_job_story_enqueue_changed(integer)','EXECUTE') AND NOT has_function_privilege('authenticated','context_job_story_enqueue_changed(integer)','EXECUTE'));
 PERFORM pg_temp.requeue_assert('fixed definer path retained',EXISTS(SELECT 1 FROM pg_proc WHERE oid='context_job_story_enqueue_changed(integer)'::regprocedure AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']));
END $proof$;
SELECT jsonb_build_object('legacy',current_setting('test.requeue_legacy')::boolean,'checks',jsonb_agg(to_jsonb(requeue_checks))) FROM requeue_checks;
ROLLBACK;

\if :has_story_ledger_witness
\ir ../../../migrations/20261030185500_context_story_ledger_witness.sql
\endif
