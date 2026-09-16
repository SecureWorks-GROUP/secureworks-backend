\set ON_ERROR_STOP on
-- B3 lane: event-date expiry, custody transitions, trust, and the D4 budget scope,
-- exercised after a double apply of both forward migrations.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j uuid:=gen_random_uuid(); holding uuid:=gen_random_uuid();
 e uuid; ev jsonb; e2 uuid; ev2 jsonb; claimed jsonb; run uuid; tok uuid; result jsonb; facts jsonb; snap jsonb; tr jsonb;
 state_id uuid; d date:=(now() AT TIME ZONE 'Australia/Perth')::date; source_time timestamptz:=now()-interval '2 hours';
BEGIN
 -- Double apply left exactly one of each guard.
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.job_context'::regclass AND conname IN ('job_context_kind_check','job_context_lifecycle_v2_check','job_context_trust_v2_check'))<>3
 OR (SELECT count(*) FROM pg_trigger WHERE tgname='context_fact_stamp_trust' AND NOT tgisinternal)<>2
 OR (SELECT count(*) FROM pg_proc WHERE proname='persist_luna_context_revision')<>2
 THEN RAISE EXCEPTION 'B3 re-apply duplicated guards'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,org,'accepted','patio','B3-'||j);
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata) VALUES(holding,org,'archived','fencing','B3-HOLD-'||holding,'{"do_not_schedule":true,"purpose":"pdf_unlock_bucket"}');
 INSERT INTO public.business_events(job_id,match_method,direction,payload,event_at) VALUES(j,'direct_job_id','inbound','{"body":"Crew are on site today, gate is on the left."}',source_time) RETURNING id,to_jsonb(business_events) INTO e,ev;
 INSERT INTO public.business_events(job_id,match_method,direction,payload,event_at) VALUES(holding,'direct_job_id','inbound','{"body":"Supplier bill attached"}',source_time);
 IF (ev->>'context_captured_at') IS NULL THEN RAISE EXCEPTION 'B3 capture stamp missing (20260914110000 not applied)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id=j) THEN RAISE EXCEPTION 'B3 real job not a candidate'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id=holding) THEN RAISE EXCEPTION 'B3 holding job admitted'; END IF;
 claimed:=public.claim_context_extraction_run(j,d,'extraction'); run:=(claimed->'run'->>'id')::uuid; tok:=(claimed->'run'->>'lease_token')::uuid;
 facts:=jsonb_build_array(
  jsonb_build_object('kind','current_state','text','Crew are on site.','confidence',0.9,'source_event_ids',jsonb_build_array(e),'evidence_excerpt','Crew are on site today'),
  jsonb_build_object('kind','access_note','text','Gate is on the left.','confidence',0.9,'source_event_ids',jsonb_build_array(e)));
 result:=public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev),facts,'[]','[]');
 IF result->>'outcome'<>'inserted' OR (result->>'facts_new')::int<>2 THEN RAISE EXCEPTION 'B3 insert %',result; END IF;
 state_id:=(result->'fact_ids'->>0)::uuid;
 -- current_state ends at Perth midnight of the event's day, never 24h after the write.
 IF (SELECT expires_at FROM public.job_temporary_context WHERE id=state_id) IS DISTINCT FROM (((source_time AT TIME ZONE 'Australia/Perth')::date+1)::timestamp AT TIME ZONE 'Australia/Perth')
 OR (SELECT trust||'/'||extractor_version||'/'||lifecycle FROM public.job_temporary_context WHERE id=state_id)<>'luna/luna_v2/current'
 THEN RAISE EXCEPTION 'B3 current_state expiry'; END IF;
 IF (SELECT count(*) FROM public.current_job_context_facts WHERE job_id=j)<>2 THEN RAISE EXCEPTION 'B3 current view'; END IF;
 -- Age the completed run so today's one-run-per-job guard is not what excludes the job below.
 UPDATE public.context_extraction_runs SET run_date=d-2 WHERE id=run;
 -- Receipted evidence does not re-run the job; our own reply alone does not either.
 IF EXISTS(SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id=j) THEN RAISE EXCEPTION 'B3 receipted job still a candidate'; END IF;
 INSERT INTO public.business_events(job_id,match_method,direction,payload,event_at) VALUES(j,'direct_job_id','outbound','{"body":"Thanks, on our way"}',now());
 IF EXISTS(SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id=j) THEN RAISE EXCEPTION 'B3 outbound-only evidence admitted'; END IF;
 -- A new inbound row re-admits the job and the retract path retires the stale state.
 INSERT INTO public.business_events(job_id,match_method,direction,payload,event_at) VALUES(j,'direct_job_id','inbound','{"body":"Crew have left, all done."}',now()) RETURNING id,to_jsonb(business_events) INTO e2,ev2;
 IF NOT EXISTS(SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id=j) THEN RAISE EXCEPTION 'B3 new inbound did not re-admit'; END IF;
 -- The new inbound row is its own anchor; our reply rides along as context.
 IF (SELECT count(*) FROM public.context_extraction_events(j,25))<>2 THEN RAISE EXCEPTION 'B3 batch shape (new inbound anchor + our reply)'; END IF;
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,lease_token,lease_expires_at) VALUES(j,d-1,'extraction','running',gen_random_uuid(),now()+interval '20 minutes') RETURNING id,lease_token INTO run,tok;
 SELECT to_jsonb(v) INTO snap FROM public.current_job_context_facts v WHERE id=state_id;
 tr:=jsonb_build_array(jsonb_build_object('fact_id',state_id,'fact_store','job_temporary_context','reason','Crew have left','source_event_ids',jsonb_build_array(e2),'expected_fact',snap));
 result:=public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev2),'[]','[]',tr);
 IF result->>'outcome'<>'inserted' OR result->>'facts_retracted'<>'1' THEN RAISE EXCEPTION 'B3 retract %',result; END IF;
 IF (SELECT lifecycle||'/'||coalesce(lifecycle_reason,'') FROM public.job_temporary_context WHERE id=state_id)<>'retracted/Crew have left'
 OR EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=state_id)
 OR (SELECT count(*) FROM public.current_job_context_facts WHERE job_id=j)<>1
 THEN RAISE EXCEPTION 'B3 retracted row still current'; END IF;
END $$;
ROLLBACK;
