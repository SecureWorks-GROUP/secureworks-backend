BEGIN;
DO $$
DECLARE w date:=date_trunc('week',now() AT TIME ZONE 'Australia/Perth')::date-7; d date; j uuid:=gen_random_uuid(); repeat_job uuid:=gen_random_uuid(); sibling uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
 event_id uuid; chosen_job uuid; fact_kind text; store text; count_facts integer; n integer; r record; out jsonb; snap jsonb; cov jsonb;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (j,'00000000-0000-0000-0000-000000000001','accepted','patio','B4-'||j,'b4-single'),
 (repeat_job,'00000000-0000-0000-0000-000000000001','accepted','patio','B4-'||repeat_job,'b4-repeat'),
 (sibling,'00000000-0000-0000-0000-000000000001','closed','patio','B4-'||sibling,'b4-repeat');
 INSERT INTO public.users(id,org_id,name,role) VALUES(actor,'00000000-0000-0000-0000-000000000001','Review Operator','ops_manager');
 FOREACH d IN ARRAY ARRAY[w-28,w-14,w-7,w] LOOP
  count_facts:=CASE WHEN d<w-7 THEN 3 ELSE 40 END;
  FOR n IN 1..count_facts LOOP
   chosen_job:=CASE WHEN n BETWEEN 21 AND 30 THEN repeat_job ELSE j END;
   fact_kind:=CASE WHEN n<=10 THEN 'scope_spec' WHEN n<=20 THEN 'pending_action' ELSE 'note' END;
   store:=CASE WHEN fact_kind='pending_action' THEN 'job_temporary_context' ELSE 'job_context' END;
   INSERT INTO public.business_events(job_id,payload,event_at) VALUES(chosen_job,jsonb_build_object('body','Source fixture '||n),(d+2)::timestamp AT TIME ZONE 'Australia/Perth') RETURNING id INTO event_id;
   EXECUTE format('INSERT INTO public.%I(id,job_id,kind,value,provenance,created_at,event_date,source_event_ids,extractor_version,trust,expires_at)
    VALUES(gen_random_uuid(),$1,$2,$3,''{}'',$4,$5,$6,''luna_v2'',''luna'',now()+interval ''1 day'')',store)
    USING chosen_job,fact_kind,jsonb_build_object('text','Fact fixture '||n),(d+2)::timestamp AT TIME ZONE 'Australia/Perth',d+2,ARRAY[event_id];
  END LOOP;
  out:=public.context_accuracy_draw(d);
  IF (out->'week'->>'n_sampled')::int<>count_facts THEN RAISE EXCEPTION 'B4 sample count %',out; END IF;
  IF public.context_accuracy_draw(d)->>'outcome'<>'idempotent' THEN RAISE EXCEPTION 'B4 unstable draw'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.context_accuracy_samples WHERE week_start=w GROUP BY bucket HAVING count(*)<>10)
 OR (SELECT count(DISTINCT fact_store||fact_id::text) FROM public.context_accuracy_samples WHERE week_start=w)<>40 THEN RAISE EXCEPTION 'B4 overlapping strata'; END IF;
 -- A gap between bad weeks must not count as consecutive.
 FOREACH d IN ARRAY ARRAY[w-28,w-14] LOOP
  FOR r IN SELECT * FROM public.context_accuracy_samples WHERE week_start=d LOOP
   out:=public.record_context_accuracy_verdict(d,r.fact_id,r.fact_store,'wrong_job',actor,false);
  END LOOP;
  IF NOT public.automation_lane_enabled('extraction') THEN RAISE EXCEPTION 'B4 calendar gap triggered'; END IF;
 END LOOP;
 IF out->>'accuracy'<>'0.00000000000000000000' AND (out->>'accuracy')::numeric<>0 THEN RAISE EXCEPTION 'B4 actual denominator'; END IF;
 IF (out->>'missing')::int<>37 OR (out->>'sample_sufficient')::boolean THEN RAISE EXCEPTION 'B4 missing sample hidden'; END IF;
 -- Three observed wrong-job facts suffice even with 37 unjudged this week.
 FOR r IN SELECT * FROM public.context_accuracy_samples WHERE week_start=w-7 LIMIT 3 LOOP
  out:=public.record_context_accuracy_verdict(w-7,r.fact_id,r.fact_store,'wrong_job',actor,false);
 END LOOP;
 IF public.automation_lane_enabled('extraction') THEN RAISE EXCEPTION 'B4 partial wrong-job breach ignored'; END IF;
 UPDATE public.automation_switches SET extraction=true;
 -- A different breach type next week still makes two consecutive bad weeks.
 n:=0;
 FOR r IN SELECT * FROM public.context_accuracy_samples WHERE week_start=w ORDER BY fact_id LOOP
  n:=n+1;
  out:=public.record_context_accuracy_verdict(w,r.fact_id,r.fact_store,CASE WHEN n<=34 THEN 'true' ELSE 'false' END,actor,false);
 END LOOP;
 IF public.automation_lane_enabled('extraction') OR out->>'extraction_stopped'<>'true' THEN RAISE EXCEPTION 'B4 mixed consecutive breach ignored'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_accuracy_alerts WHERE week_start=w AND reason='accuracy_two_weeks' AND delivered_at IS NULL) THEN RAISE EXCEPTION 'B4 alert absent'; END IF;
 -- A later explicit invented payment finding stops immediately, even after publication.
 UPDATE public.automation_switches SET extraction=true;
 SELECT * INTO r FROM public.context_accuracy_samples WHERE week_start=w LIMIT 1;
 out:=public.record_context_accuracy_verdict(w,r.fact_id,r.fact_store,'false',actor,true);
 IF public.automation_lane_enabled('extraction') OR NOT EXISTS(SELECT 1 FROM public.context_accuracy_alerts WHERE reason='invented_payment') THEN RAISE EXCEPTION 'B4 payment tripwire'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_accuracy_samples WHERE week_start=w AND judged_by='Review Operator' AND judged_user_id=actor) THEN RAISE EXCEPTION 'B4 actor attribution'; END IF;
 cov:=public.context_coverage();
 IF (cov->'jobs'->>'total')::int<2 OR (cov->'jobs'->>'with_current_fact')::int<2 THEN RAISE EXCEPTION 'B4 coverage unavailable'; END IF;
 snap:=public.context_pipeline_status();
 IF snap->'latest_accuracy_week'->>'week_start'<>w::text OR jsonb_array_length(snap->'accuracy_alerts')=0 THEN RAISE EXCEPTION 'B4 status omits review'; END IF;
 IF snap->>'model_call_budget_state'='unavailable' AND snap->'model_calls_used'<>'null'::jsonb THEN RAISE EXCEPTION 'B4 unknown budget shown as zero'; END IF;
 IF has_function_privilege('anon','public.record_context_accuracy_verdict(date,uuid,text,text,uuid,boolean)','EXECUTE') THEN RAISE EXCEPTION 'B4 public verdict'; END IF;
END $$;
ROLLBACK;
