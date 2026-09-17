BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001';
 j uuid:=gen_random_uuid(); missing uuid:=gen_random_uuid(); prefer uuid:=gen_random_uuid();
 e uuid; ev jsonb; run uuid; tok uuid; claimed jsonb; result jsonb; facts jsonb;
 fact uuid; d date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 occurred_time timestamptz:=(d::timestamp + interval '15 hours') AT TIME ZONE 'Australia/Perth';
 event_time timestamptz:=(d::timestamp + interval '12 hours') AT TIME ZONE 'Australia/Perth';
 later_occurred timestamptz:=((d + 2)::timestamp + interval '12 hours') AT TIME ZONE 'Australia/Perth';
 due date:=d + 2;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES
  (j,org,'accepted','patio','EVT-FALLBACK-'||j),
  (missing,org,'accepted','patio','EVT-BOTH-NULL-'||missing),
  (prefer,org,'accepted','patio','EVT-PREFER-'||prefer);

 -- 1. event_at null and occurred_at set is accepted; event_date and expiry follow occurred_at.
 INSERT INTO public.business_events(job_id,match_method,direction,payload,occurred_at)
  VALUES(j,'direct_job_id','inbound',jsonb_build_object('body','Crew are on site today. Delivery '||due::text||'.'),occurred_time)
  RETURNING id,to_jsonb(business_events) INTO e,ev;
 IF ev->>'event_at' IS NOT NULL THEN RAISE EXCEPTION 'occurred_at fixture leaked event_at'; END IF;
 IF ev->>'occurred_at' IS NULL THEN RAISE EXCEPTION 'occurred_at fixture missing occurred_at'; END IF;
 claimed:=public.claim_context_extraction_run(j,d,'extraction'); run:=(claimed->'run'->>'id')::uuid; tok:=(claimed->'run'->>'lease_token')::uuid;
 facts:=jsonb_build_array(
  jsonb_build_object('kind','current_state','text','Crew are on site.','confidence',0.9,'source_event_ids',jsonb_build_array(e),'evidence_excerpt','Crew are on site today'),
  jsonb_build_object('kind','pending_action','text','Delivery is arranged.','confidence',0.8,'source_event_ids',jsonb_build_array(e),'due_date',due,'evidence_excerpt','Delivery '||due::text||'.'));
 result:=public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev),facts,'[]','[]');
 IF result->>'outcome'<>'inserted' OR (result->>'facts_new')::int<>2 THEN RAISE EXCEPTION 'occurred_at fallback rejected %',result; END IF;
 fact:=(result->'fact_ids'->>0)::uuid;
 IF (SELECT event_date FROM public.job_temporary_context WHERE id=fact) IS DISTINCT FROM (occurred_time AT TIME ZONE 'Australia/Perth')::date
  OR (SELECT expires_at FROM public.job_temporary_context WHERE id=fact) IS DISTINCT FROM (((occurred_time AT TIME ZONE 'Australia/Perth')::date+1)::timestamp AT TIME ZONE 'Australia/Perth')
  OR (SELECT (provenance->>'event_at')::timestamptz FROM public.job_temporary_context WHERE id=fact) IS DISTINCT FROM occurred_time
 THEN RAISE EXCEPTION 'occurred_at fallback dated from the wrong clock'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact)
  OR NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=(result->'fact_ids'->>1)::uuid)
 THEN RAISE EXCEPTION 'occurred_at-only fact hidden from current view'; END IF;
 IF (SELECT event_date FROM public.job_temporary_context WHERE id=(result->'fact_ids'->>1)::uuid) IS DISTINCT FROM (occurred_time AT TIME ZONE 'Australia/Perth')::date
  OR (SELECT expires_at FROM public.job_temporary_context WHERE id=(result->'fact_ids'->>1)::uuid) IS DISTINCT FROM ((due + 1)::timestamp AT TIME ZONE 'Australia/Perth')
 THEN RAISE EXCEPTION 'occurred_at due-date support used a null source time'; END IF;

 -- 2. both timestamps null still reject with luna_source_attribution_rejected.
 ALTER TABLE public.business_events ALTER COLUMN occurred_at DROP NOT NULL;
 INSERT INTO public.business_events(job_id,match_method,direction,payload,event_at,occurred_at)
  VALUES(missing,'direct_job_id','inbound','{"body":"No clock on this row"}',NULL,NULL)
  RETURNING id,to_jsonb(business_events) INTO e,ev;
 claimed:=public.claim_context_extraction_run(missing,d,'extraction'); run:=(claimed->'run'->>'id')::uuid; tok:=(claimed->'run'->>'lease_token')::uuid;
 facts:=jsonb_build_array(jsonb_build_object('kind','note','text','No clock.','confidence',0.9,'source_event_ids',jsonb_build_array(e)));
 BEGIN
  PERFORM public.persist_luna_context_revision(run,tok,missing,jsonb_build_array(ev),facts,'[]','[]');
  RAISE EXCEPTION 'both-null source time accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_source_attribution_rejected' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM public.context_extraction_event_receipts WHERE run_id=run) THEN RAISE EXCEPTION 'both-null source acknowledged'; END IF;
 fact:=gen_random_uuid();
 INSERT INTO public.job_context(id,job_id,kind,value,provenance,lifecycle,source_event_ids,extractor_version,trust)
  VALUES(fact,missing,'note','{"text":"No clock."}','{"extractor":"luna_v2","writer_role":"classifier"}','current',ARRAY[e],'luna_v2','luna');
 IF NOT EXISTS(SELECT 1 FROM public.job_context WHERE id=fact)
  OR EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact)
 THEN RAISE EXCEPTION 'both-null luna_v2 fact leaked into current view'; END IF;

 -- 3. event_at wins when the two timestamps differ.
 INSERT INTO public.business_events(job_id,match_method,direction,payload,event_at,occurred_at)
  VALUES(prefer,'direct_job_id','inbound','{"body":"Prefers the earlier stamp"}',event_time,later_occurred)
  RETURNING id,to_jsonb(business_events) INTO e,ev;
 claimed:=public.claim_context_extraction_run(prefer,d,'extraction'); run:=(claimed->'run'->>'id')::uuid; tok:=(claimed->'run'->>'lease_token')::uuid;
 facts:=jsonb_build_array(jsonb_build_object('kind','current_state','text','Prefers the earlier stamp.','confidence',0.9,'source_event_ids',jsonb_build_array(e)));
 result:=public.persist_luna_context_revision(run,tok,prefer,jsonb_build_array(ev),facts,'[]','[]');
 IF result->>'outcome'<>'inserted' THEN RAISE EXCEPTION 'event_at preferred source rejected %',result; END IF;
 fact:=(result->'fact_ids'->>0)::uuid;
 IF (SELECT event_date FROM public.job_temporary_context WHERE id=fact) IS DISTINCT FROM (event_time AT TIME ZONE 'Australia/Perth')::date
  OR (SELECT expires_at FROM public.job_temporary_context WHERE id=fact) IS DISTINCT FROM (((event_time AT TIME ZONE 'Australia/Perth')::date+1)::timestamp AT TIME ZONE 'Australia/Perth')
  OR (SELECT (provenance->>'event_at')::timestamptz FROM public.job_temporary_context WHERE id=fact) IS DISTINCT FROM event_time
  OR NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact)
 THEN RAISE EXCEPTION 'event_at did not outrank occurred_at'; END IF;
END $$;
ROLLBACK;
