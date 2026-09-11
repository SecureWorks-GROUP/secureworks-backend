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
   INSERT INTO public.business_events(job_id,match_method,payload,event_at) VALUES(chosen_job,'direct_job_id',jsonb_build_object('body','Source fixture '||n),(d+2)::timestamp AT TIME ZONE 'Australia/Perth') RETURNING id INTO event_id;
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
-- Reviews can arrive in reverse calendar order. Neither partial wrong-job
-- findings nor mixed percentage/wrong-job findings may depend on review order.
DO $$
DECLARE w date:=date_trunc('week',now() AT TIME ZONE 'Australia/Perth')::date-7;
 d date; j uuid:=gen_random_uuid(); sibling uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
 event_id uuid; n integer; r record; result jsonb; store text; fact_kind text;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (j,'00000000-0000-0000-0000-000000000001','accepted','patio','B4-REVERSE-'||j,'b4-reverse-'||j),
 (sibling,'00000000-0000-0000-0000-000000000001','closed','patio','B4-REVERSE-'||sibling,'b4-reverse-'||j);
 INSERT INTO public.users(id,org_id,name,role) VALUES(actor,'00000000-0000-0000-0000-000000000001','Reverse Review Operator','ops_manager');
 FOREACH d IN ARRAY ARRAY[w-70,w-63,w-49,w-42] LOOP
  FOR n IN 1..40 LOOP
   fact_kind:=CASE WHEN n<=10 THEN 'scope_spec' WHEN n<=20 THEN 'pending_action' ELSE 'note' END;
   store:=CASE WHEN fact_kind='pending_action' THEN 'job_temporary_context' ELSE 'job_context' END;
   INSERT INTO public.business_events(job_id,match_method,payload,event_at)
    VALUES(j,'direct_job_id',jsonb_build_object('body','Reverse review source '||n),(d+2)::timestamp AT TIME ZONE 'Australia/Perth') RETURNING id INTO event_id;
   EXECUTE format('INSERT INTO public.%I(id,job_id,kind,value,provenance,created_at,event_date,source_event_ids,extractor_version,trust,expires_at)
    VALUES(gen_random_uuid(),$1,$2,$3,''{}'',$4,$5,$6,''luna_v2'',''luna'',now()+interval ''1 day'')',store)
    USING j,fact_kind,jsonb_build_object('text','Reverse review fact '||n),(d+2)::timestamp AT TIME ZONE 'Australia/Perth',d+2,ARRAY[event_id];
  END LOOP;
  result:=public.context_accuracy_draw(d);
  IF (result#>>'{week,n_sampled}')::integer IS DISTINCT FROM 40 THEN RAISE EXCEPTION 'B4 reverse fixture must draw forty'; END IF;
 END LOOP;
 UPDATE public.automation_switches SET extraction=true WHERE id=1;
 FOREACH d IN ARRAY ARRAY[w-63,w-70] LOOP
  FOR r IN SELECT * FROM public.context_accuracy_samples WHERE week_start=d ORDER BY fact_id LIMIT 3 LOOP
   result:=public.record_context_accuracy_verdict(d,r.fact_id,r.fact_store,'wrong_job',actor,false);
  END LOOP;
  IF d=w-63 AND NOT public.automation_lane_enabled('extraction') THEN RAISE EXCEPTION 'B4 isolated newer breach stopped extraction'; END IF;
 END LOOP;
 IF public.automation_lane_enabled('extraction') OR NOT EXISTS(
  SELECT 1 FROM public.context_accuracy_alerts WHERE week_start=w-63 AND reason='accuracy_two_weeks' AND delivered_at IS NULL)
 THEN RAISE EXCEPTION 'B4 reverse partial pair failed to stop'; END IF;
 -- Correct both weeks completely. Corrections preserve the operator stop and
 -- its pending notification; a human must explicitly re-enable extraction.
 FOR r IN SELECT * FROM public.context_accuracy_samples WHERE week_start IN (w-70,w-63) ORDER BY week_start,fact_id LOOP
  result:=public.record_context_accuracy_verdict(r.week_start,r.fact_id,r.fact_store,'true',actor,false);
 END LOOP;
 IF public.automation_lane_enabled('extraction') OR NOT EXISTS(
  SELECT 1 FROM public.context_accuracy_alerts WHERE week_start=w-63 AND reason='accuracy_two_weeks' AND delivered_at IS NULL)
 THEN RAISE EXCEPTION 'B4 correction re-enabled extraction or erased pending stop'; END IF;
 UPDATE public.automation_switches SET extraction=true WHERE id=1;
 n:=0;
 FOR r IN SELECT * FROM public.context_accuracy_samples WHERE week_start=w-42 ORDER BY fact_id LOOP
  n:=n+1;
  result:=public.record_context_accuracy_verdict(w-42,r.fact_id,r.fact_store,CASE WHEN n<=35 THEN 'true' ELSE 'false' END,actor,false);
 END LOOP;
 IF NOT public.automation_lane_enabled('extraction') THEN RAISE EXCEPTION 'B4 isolated newer percentage breach stopped extraction'; END IF;
 FOR r IN SELECT * FROM public.context_accuracy_samples WHERE week_start=w-49 ORDER BY fact_id LIMIT 3 LOOP
  result:=public.record_context_accuracy_verdict(w-49,r.fact_id,r.fact_store,'wrong_job',actor,false);
 END LOOP;
 IF public.automation_lane_enabled('extraction') OR NOT EXISTS(
  SELECT 1 FROM public.context_accuracy_alerts WHERE week_start=w-42 AND reason='accuracy_two_weeks' AND delivered_at IS NULL)
 THEN RAISE EXCEPTION 'B4 reverse mixed pair failed to stop'; END IF;
END $$;

-- Coverage describes source availability separately from current extracted facts.
-- Compare deltas so unrelated registry fixtures cannot manufacture a pass/fail.
DO $$
DECLARE empty_job uuid:=gen_random_uuid(); pending_job uuid:=gen_random_uuid(); expired_job uuid:=gen_random_uuid();
 event_id uuid; j uuid; before_counts jsonb; after_counts jsonb; section text;
BEGIN
 before_counts:=public.context_coverage();
 FOREACH j IN ARRAY ARRAY[empty_job,pending_job,expired_job] LOOP
  INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,'00000000-0000-0000-0000-000000000001','accepted','patio','B4-COVERAGE-'||j);
  -- Populate the actual table row type: the shared minimal fixture omits some
  -- production fields, while the full schema requires org/Xero ID/invoice_type.
  INSERT INTO public.xero_invoices SELECT (jsonb_populate_record(NULL::public.xero_invoices,jsonb_build_object(
   'id',gen_random_uuid(),'org_id','00000000-0000-0000-0000-000000000001','xero_invoice_id',gen_random_uuid()::text,
   'job_id',j,'invoice_number','B4-COVERAGE-'||j,'invoice_type','ACCREC','type','ACCREC','status','AUTHORISED','amount_due',100,'updated_at',now(),'created_at',now()))).*;
 END LOOP;
 FOREACH j IN ARRAY ARRAY[pending_job,expired_job] LOOP
  INSERT INTO public.business_events(job_id,match_method,payload,event_at)
   VALUES(j,'direct_job_id','{"body":"Stored evidence awaiting current facts"}',now()-interval '10 days') RETURNING id INTO event_id;
  IF j=expired_job THEN
   INSERT INTO public.job_temporary_context(id,job_id,kind,value,provenance,event_date,source_event_ids,extractor_version,trust,expires_at)
    VALUES(gen_random_uuid(),j,'pending_action','{"text":"Historical pending action"}','{}',(now()-interval '10 days')::date,ARRAY[event_id],'luna_v2','luna',now()-interval '1 day');
  END IF;
 END LOOP;
 after_counts:=public.context_coverage();
 FOREACH section IN ARRAY ARRAY['jobs','invoices'] LOOP
  IF (after_counts#>>ARRAY[section,'total'])::integer-(before_counts#>>ARRAY[section,'total'])::integer IS DISTINCT FROM 3
   OR (after_counts#>>ARRAY[section,'with_current_fact'])::integer IS DISTINCT FROM (before_counts#>>ARRAY[section,'with_current_fact'])::integer
   OR (after_counts#>>ARRAY[section,'no_current_fact'])::integer-(before_counts#>>ARRAY[section,'no_current_fact'])::integer IS DISTINCT FROM 3
   OR (after_counts#>>ARRAY[section,'evidence_without_current_fact'])::integer-(before_counts#>>ARRAY[section,'evidence_without_current_fact'])::integer IS DISTINCT FROM 2
   OR (after_counts#>>ARRAY[section,'no_evidence_yet'])::integer-(before_counts#>>ARRAY[section,'no_evidence_yet'])::integer IS DISTINCT FROM 1
  THEN RAISE EXCEPTION 'B4 coverage conflated source evidence and current facts: % before % after %',section,before_counts,after_counts; END IF;
 END LOOP;
 IF after_counts#>'{invoices,unlinked}' IS DISTINCT FROM before_counts#>'{invoices,unlinked}' THEN RAISE EXCEPTION 'B4 linked coverage fixtures changed unlinked count'; END IF;
END $$;
ROLLBACK;
