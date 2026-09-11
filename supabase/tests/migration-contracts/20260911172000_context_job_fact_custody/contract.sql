BEGIN;
DO $$
DECLARE j uuid:=gen_random_uuid(); other_job uuid:=gen_random_uuid(); ev jsonb; ev2 jsonb; stale jsonb;
 e uuid; e2 uuid; run uuid; tok uuid; claimed jsonb; result jsonb; facts jsonb; snap jsonb; tr jsonb;
 old uuid; temp uuid; legacy uuid:=gen_random_uuid(); due date:=(now() AT TIME ZONE 'Australia/Perth')::date+2;
 source_time timestamptz:=now()-interval '1 hour'; d date:=(now() AT TIME ZONE 'Australia/Perth')::date;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.job_context WHERE id='b3000000-0000-0000-0000-000000000002') OR EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id='b3000000-0000-0000-0000-000000000002') THEN RAISE EXCEPTION 'B3 legacy undated proposal must be held, not deleted or current'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES
 (j,'00000000-0000-0000-0000-000000000001','accepted','patio','B3-'||j),
 (other_job,'00000000-0000-0000-0000-000000000001','accepted','patio','B3-'||other_job);
 INSERT INTO public.business_events(job_id,match_method,payload,event_at) VALUES(j,'direct_job_id',jsonb_build_object('body','Blue roof. Gate access on '||due::text),source_time) RETURNING id,to_jsonb(business_events) INTO e,ev;
 claimed:=public.claim_context_extraction_run(j,d,'extraction'); run:=(claimed->'run'->>'id')::uuid;tok:=(claimed->'run'->>'lease_token')::uuid;
 facts:=jsonb_build_array(
  jsonb_build_object('kind','scope_spec','text','Blue roof.','confidence',0.9,'source_event_ids',jsonb_build_array(e),'evidence_excerpt','Blue roof.'),
  jsonb_build_object('kind','pending_action','text','Gate access arranged.','confidence',0.8,'source_event_ids',jsonb_build_array(e),'due_date',due),
  jsonb_build_object('kind','proposal','text','Consider blue.','confidence',0.8,'source_event_ids',jsonb_build_array(e)),
  jsonb_build_object('kind','client_preference','text','Prefers blue.','confidence',0.8,'source_event_ids',jsonb_build_array(e)));
 stale:=jsonb_set(ev,'{payload}','{"body":"Fabricated"}');
 BEGIN
  PERFORM public.persist_luna_context_revision(run,tok,j,jsonb_build_array(stale),facts,'[]','[]');
  RAISE EXCEPTION 'B3 stale source accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_source_revision_stale' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM public.context_extraction_event_receipts WHERE run_id=run) THEN RAISE EXCEPTION 'B3 stale source acknowledged'; END IF;
 result:=public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev),facts,'[]','[]','luna_v2',120);
 IF result->>'outcome'<>'inserted' OR (result->>'facts_new')::int<>4 THEN RAISE EXCEPTION 'B3 insert %',result; END IF;
 old:=(result->'fact_ids'->>0)::uuid;temp:=(result->'fact_ids'->>1)::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.context_extraction_runs WHERE id=run AND status='done' AND tokens_in=120)
 OR NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts WHERE run_id=run AND event_id=e) THEN RAISE EXCEPTION 'B3 atomic completion'; END IF;
 IF (SELECT expires_at FROM public.job_temporary_context WHERE id=temp) IS DISTINCT FROM ((due+1)::timestamp AT TIME ZONE 'Australia/Perth') THEN RAISE EXCEPTION 'B3 due expiry'; END IF;
 IF (SELECT attribution_confidence FROM public.job_context WHERE id=old) IS DISTINCT FROM (ev->>'attribution_confidence')::numeric THEN RAISE EXCEPTION 'B3 derived confidence'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_context WHERE job_id=j AND kind='proposal' AND expires_at=source_time+interval '504 hours') THEN RAISE EXCEPTION 'B3 proposal expiry'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_context WHERE job_id=j AND kind='client_preference' AND review_at IS NOT NULL AND expires_at IS NULL) THEN RAISE EXCEPTION 'B3 preference review'; END IF;
 result:=public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev),facts,'[]','[]');
 IF result->>'outcome'<>'idempotent' OR (SELECT count(*) FROM public.job_context WHERE job_id=j)<>3 THEN RAISE EXCEPTION 'B3 retry duplicate'; END IF;
 IF public.context_fact_expiry('current_state','2026-09-10 12:00+08') IS DISTINCT FROM '2026-09-11 00:00+08'::timestamptz
 OR public.context_fact_expiry('pending_action','2026-09-10 12:00+08') IS DISTINCT FROM '2026-09-17 12:00+08'::timestamptz
 OR public.context_fact_expiry('quote_issue','2026-09-10 12:00+08') IS DISTINCT FROM '2026-09-24 12:00+08'::timestamptz
 THEN RAISE EXCEPTION 'B3 source expiry'; END IF;
 -- A second logical run uses a separate day slot to exercise revision transitions.
 INSERT INTO public.business_events(job_id,match_method,payload,event_at) VALUES(j,'direct_job_id','{"body":"Use green instead. Gate access cancelled."}',now()) RETURNING id,to_jsonb(business_events) INTO e2,ev2;
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,lease_token,lease_expires_at)
 VALUES(j,d-1,'extraction','running',gen_random_uuid(),now()+interval '20 minutes') RETURNING id,lease_token INTO run,tok;
 SELECT to_jsonb(v) INTO snap FROM public.current_job_context_facts v WHERE id=old;
 tr:=jsonb_build_array(jsonb_build_object('fact_id',old,'fact_store','job_context','reason','Source corrects colour','source_event_ids',jsonb_build_array(e2),'new_fact_index',0,'expected_fact',snap));
 -- Human edit after prompt read must hold before any writes or acknowledgments.
 UPDATE public.job_context SET value='{"text":"Human correction"}' WHERE id=old;
 facts:=jsonb_build_array(jsonb_build_object('kind','scope_spec','text','Use green.','confidence',0.9,'source_event_ids',jsonb_build_array(e2),'evidence_excerpt','Use green'));
 result:=public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev2),facts,tr,'[]');
 IF result->>'outcome'<>'held' OR EXISTS(SELECT 1 FROM public.context_extraction_event_receipts WHERE event_id=e2)
 THEN RAISE EXCEPTION 'B3 human edit lost custody'; END IF;
 -- Missing source time / wrong job / unsupported due dates must fail without receipts.
 BEGIN
  PERFORM public.persist_luna_context_revision(run,tok,other_job,jsonb_build_array(ev2),facts,'[]','[]');
  RAISE EXCEPTION 'B3 wrong run job accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_run_identity_invalid' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev2),
   jsonb_build_array(jsonb_build_object('kind','pending_action','text','Due tomorrow','confidence',0.9,'source_event_ids',jsonb_build_array(e2),'due_date','2099-01-01')),'[]','[]');
  RAISE EXCEPTION 'B3 unsupported due accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_due_date_unsupported' THEN RAISE; END IF; END;
 UPDATE public.business_events SET event_at=NULL WHERE id=e2 RETURNING to_jsonb(business_events) INTO stale;
 BEGIN
  PERFORM public.persist_luna_context_revision(run,tok,j,jsonb_build_array(stale),facts,'[]','[]');
  RAISE EXCEPTION 'B3 missing event time accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_source_attribution_rejected' THEN RAISE; END IF; END;
 UPDATE public.business_events SET event_at=(ev2->>'event_at')::timestamptz WHERE id=e2 RETURNING to_jsonb(business_events) INTO ev2;
 UPDATE public.automation_switches SET extraction=false;
 result:=public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev2),facts,'[]','[]');
 IF result->>'outcome'<>'held' OR EXISTS(SELECT 1 FROM public.context_extraction_event_receipts WHERE event_id=e2) THEN RAISE EXCEPTION 'B3 paused lane wrote'; END IF;
 UPDATE public.automation_switches SET extraction=true;
 -- Legacy classifier facts can be superseded via expected-fact CAS.
 INSERT INTO public.job_context(id,job_id,kind,value,provenance) VALUES(legacy,j,'scope_spec','{"text":"Old model colour"}',
  '{"extractor":"context-fact-extractor:v1.5","writer_role":"classifier"}');
 SELECT to_jsonb(v) INTO snap FROM public.current_job_context_facts v WHERE id=legacy;
 tr:=jsonb_build_array(jsonb_build_object('fact_id',legacy,'fact_store','job_context','reason','Updated source','source_event_ids',jsonb_build_array(e2),'new_fact_index',0,'expected_fact',snap));
 SELECT to_jsonb(v) INTO snap FROM public.current_job_context_facts v WHERE id=temp;
 result:=public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev2),facts,tr,
  jsonb_build_array(jsonb_build_object('fact_id',temp,'fact_store','job_temporary_context','reason','Access cancelled','source_event_ids',jsonb_build_array(e2),'expected_fact',snap)));
 IF result->>'outcome'<>'inserted' OR result->>'facts_superseded'<>'1' OR result->>'facts_retracted'<>'1'
 THEN RAISE EXCEPTION 'B3 transitions %',result; END IF;
 IF (SELECT lifecycle FROM public.job_context WHERE id=legacy)<>'superseded'
 OR (SELECT lifecycle FROM public.job_temporary_context WHERE id=temp)<>'retracted'
 OR EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id IN (legacy,temp))
 THEN RAISE EXCEPTION 'B3 history visibility'; END IF;
 IF (SELECT value->>'text' FROM public.job_context WHERE id=old)<>'Human correction' THEN RAISE EXCEPTION 'B3 human edit overwritten'; END IF;
 -- Expired permanent proposals and quote issues after a quote are filtered in SQL.
 INSERT INTO public.job_context(id,job_id,kind,value,provenance,expires_at) VALUES(gen_random_uuid(),j,'proposal','{"text":"Expired"}','{}',now()-interval '1 second');
 INSERT INTO public.job_temporary_context(id,job_id,kind,value,provenance,expires_at) VALUES(gen_random_uuid(),j,'quote_issue','{"text":"Before quote"}',jsonb_build_object('event_at',now()-interval '1 day'),now()+interval '13 days');
 UPDATE public.jobs SET quoted_at=now() WHERE id=j;
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE job_id=j AND (value->>'text'='Expired' OR value->>'text'='Before quote')) THEN RAISE EXCEPTION 'B3 expiry view'; END IF;
 UPDATE public.jobs SET quoted_at=NULL WHERE id=j;
 INSERT INTO public.job_events(id,job_id,event_type,created_at) VALUES(gen_random_uuid(),j,'quote_sent',now());
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE job_id=j AND value->>'text'='Before quote') THEN RAISE EXCEPTION 'B3 resent quote expiry'; END IF;
 UPDATE public.business_events SET job_id=other_job WHERE id=e;
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=old) THEN RAISE EXCEPTION 'B3 rebound source leaked'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_context WHERE id=old) THEN RAISE EXCEPTION 'B3 rebound source history lost'; END IF;
 UPDATE public.business_events SET job_id=j,attribution_status='admin_bucket' WHERE id=e;
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=old) THEN RAISE EXCEPTION 'B3 revoked source leaked'; END IF;
 UPDATE public.job_context SET source_event_ids=ARRAY[gen_random_uuid()] WHERE id=old;
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=old) THEN RAISE EXCEPTION 'B3 missing source leaked'; END IF;
 IF has_function_privilege('anon','public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)','EXECUTE') THEN RAISE EXCEPTION 'B3 public write'; END IF;
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE text_value text; got date; anchor timestamptz:='2026-09-11 17:00:00+08';
BEGIN
 FOREACH text_value IN ARRAY ARRAY['14/09/2026','14-09-2026','14 September 2026','14th Sep 2026','14 Sep. 2026','Sept. 14th, 2026','September 14th, 2026','14 Sept','September 14','14/09','2026-09-14','Monday 14 September 2026'] LOOP
  got:=public.context_supported_due_date(text_value,anchor);
  IF got IS DISTINCT FROM '2026-09-14'::date THEN RAISE EXCEPTION 'B3 named date failed: % -> %',text_value,got; END IF;
 END LOOP;
 IF public.context_supported_due_date('today',anchor) IS DISTINCT FROM '2026-09-11'::date
 OR public.context_supported_due_date('tomorrow',anchor) IS DISTINCT FROM '2026-09-12'::date
 OR public.context_supported_due_date('14 September','2025-09-11 17:00+08') IS DISTINCT FROM '2025-09-14'::date
 THEN RAISE EXCEPTION 'B3 source date anchor moved'; END IF;
 IF public.context_fact_expiry('pending_action',anchor,public.context_supported_due_date('tomorrow',anchor)) IS DISTINCT FROM '2026-09-13 00:00+08'::timestamptz
 OR public.context_fact_expiry('current_state',anchor) IS DISTINCT FROM '2026-09-12 00:00+08'::timestamptz
 THEN RAISE EXCEPTION 'B3 named-date expiry changed source 17h rules'; END IF;
 FOREACH text_value IN ARRAY ARRAY['31/02/2026','31 April 2026','14 September or 15 September','next Monday','last Friday','Monday','Tuesday 14 September 2026','not tomorrow','day after tomorrow','14/09/26','14 September 26','September 14 26'] LOOP
  BEGIN
   PERFORM public.context_supported_due_date(text_value,anchor);
   RAISE EXCEPTION 'B3 ambiguous date accepted: %',text_value USING ERRCODE='ZX001';
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM NOT LIKE 'luna_due_date_%' THEN RAISE; END IF;
  END;
 END LOOP;
 BEGIN
  PERFORM public.context_supported_due_date('4 January','2026-12-30 17:00+08');
  RAISE EXCEPTION 'B3 ambiguous rollover accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_due_date_ambiguous_year' THEN RAISE; END IF; END;
 IF public.context_supported_due_date('when the crew is ready',anchor) IS NOT NULL THEN RAISE EXCEPTION 'B3 invented unsupported date'; END IF;
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE j uuid:=gen_random_uuid(); e uuid; ev jsonb; claim jsonb; run uuid; token uuid; f jsonb; result jsonb;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,'00000000-0000-0000-0000-000000000001','accepted','patio','B3-DATE-'||j);
 INSERT INTO public.business_events(job_id,match_method,event_at,payload) VALUES(j,'direct_job_id','2026-09-11 17:00+08','{"body":"Delivery 14 September 2026. Pickup 15 September 2026."}') RETURNING id,to_jsonb(business_events) INTO e,ev;
 claim:=public.claim_context_extraction_run(j,(now() AT TIME ZONE 'Australia/Perth')::date,'extraction');run:=(claim->'run'->>'id')::uuid;token:=(claim->'run'->>'lease_token')::uuid;
 f:=jsonb_build_object('kind','pending_action','text','Delivery is arranged.','confidence',0.9,'source_event_ids',jsonb_build_array(e),'due_date','2026-09-14','evidence_excerpt','Delivery 14 September 2026. Pickup 15 September 2026.');
 BEGIN
  PERFORM public.persist_luna_context_revision(run,token,j,jsonb_build_array(ev),jsonb_build_array(f),'[]','[]');
  RAISE EXCEPTION 'B3 conflicting source dates allowed' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_due_date_conflicting_dates' THEN RAISE; END IF; END;
 f:=jsonb_set(f,'{evidence_excerpt}','"Delivery 14 September 2026."');
 BEGIN
  PERFORM public.persist_luna_context_revision(run,token,j,jsonb_build_array(ev),jsonb_build_array(jsonb_set(f,'{due_date}','"2026-09-15"')),'[]','[]');
  RAISE EXCEPTION 'B3 model date mismatch allowed' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_due_date_unsupported' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.persist_luna_context_revision(run,token,j,jsonb_build_array(ev),jsonb_build_array(jsonb_set(f,'{due_date}','"tomorrow"')),'[]','[]');
  RAISE EXCEPTION 'B3 clock-relative payload allowed' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_due_date_shape_invalid' THEN RAISE; END IF; END;
 result:=public.persist_luna_context_revision(run,token,j,jsonb_build_array(ev),jsonb_build_array(f),'[]','[]');
 IF result->>'outcome'<>'inserted' OR NOT EXISTS(SELECT 1 FROM public.job_temporary_context WHERE job_id=j AND expires_at='2026-09-15 00:00+08'::timestamptz AND event_date='2026-09-11'::date)
 THEN RAISE EXCEPTION 'B3 named-date RPC failed'; END IF;
END $$;
ROLLBACK;
