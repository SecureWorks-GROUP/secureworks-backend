BEGIN;
DO $$
DECLARE empty_job uuid:=gen_random_uuid(); pending_job uuid:=gen_random_uuid(); expired_job uuid:=gen_random_uuid();
 event_id uuid; j uuid; before_counts jsonb; after_counts jsonb; section text;
 snap jsonb; perth date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 missing_before integer; missing_after integer; both_null_job uuid:=gen_random_uuid();
 pending_source timestamptz:='1999-01-02 03:04:05+00';
BEGIN
 IF to_regprocedure('public.context_coverage()') IS NULL
  OR to_regprocedure('public.context_pipeline_status()') IS NULL
 THEN RAISE EXCEPTION 'heartbeat functions missing'; END IF;
 IF has_function_privilege('anon','public.context_coverage()','EXECUTE')
  OR has_function_privilege('authenticated','public.context_coverage()','EXECUTE')
  OR has_function_privilege('anon','public.context_pipeline_status()','EXECUTE')
  OR has_function_privilege('authenticated','public.context_pipeline_status()','EXECUTE')
 THEN RAISE EXCEPTION 'heartbeat public execute'; END IF;
 IF NOT has_function_privilege('service_role','public.context_coverage()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_pipeline_status()','EXECUTE')
 THEN RAISE EXCEPTION 'heartbeat service_role grant'; END IF;

 snap:=public.context_pipeline_status();
 IF (snap->>'run_date')::date IS DISTINCT FROM perth THEN RAISE EXCEPTION 'heartbeat run_date not Perth today %',snap; END IF;
 IF snap ? 'latest_accuracy_week' OR snap ? 'accuracy_alerts' THEN RAISE EXCEPTION 'heartbeat shipped accuracy fields %',snap; END IF;
 IF snap->'coverage' IS NULL OR snap->>'model_call_budget_state' IS NULL THEN RAISE EXCEPTION 'heartbeat missing coverage or budget %',snap; END IF;
 IF snap->>'model_call_budget_state'='unavailable' AND snap->'model_calls_used'<>'null'::jsonb THEN RAISE EXCEPTION 'heartbeat unknown budget shown as zero'; END IF;

 -- Coverage describes source availability separately from current extracted facts.
 before_counts:=public.context_coverage();
 FOREACH j IN ARRAY ARRAY[empty_job,pending_job,expired_job] LOOP
  INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,'00000000-0000-0000-0000-000000000001','accepted','patio','HB-COVERAGE-'||j);
  INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,amount_due,job_id,updated_at)
   VALUES('00000000-0000-0000-0000-000000000001',j::text,'HB-'||j,'ACCREC','AUTHORISED',100,j,now());
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
  THEN RAISE EXCEPTION 'heartbeat coverage conflated source evidence and current facts: % before % after %',section,before_counts,after_counts; END IF;
 END LOOP;
 IF after_counts#>'{invoices,unlinked}' IS DISTINCT FROM before_counts#>'{invoices,unlinked}' THEN RAISE EXCEPTION 'heartbeat linked coverage fixtures changed unlinked count'; END IF;

 -- occurred_at-only is healthy source time after PR 854; both-null is the defect.
 missing_before:=(public.context_pipeline_status()->>'missing_event_time')::integer;
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(both_null_job,'00000000-0000-0000-0000-000000000001','accepted','patio','HB-TIME-'||both_null_job);
 INSERT INTO public.business_events(job_id,match_method,payload,occurred_at,attribution_status)
  VALUES(both_null_job,'direct_job_id','{"body":"occurred_at only"}',pending_source,'direct');
 IF (public.context_pipeline_status()->>'missing_event_time')::integer IS DISTINCT FROM missing_before
 THEN RAISE EXCEPTION 'heartbeat counted occurred_at-only as missing event time'; END IF;
 IF (public.context_pipeline_status()->>'oldest_pending_event_at')::timestamptz IS DISTINCT FROM pending_source
 THEN RAISE EXCEPTION 'heartbeat oldest_pending ignored occurred_at-only source time'; END IF;
 ALTER TABLE public.business_events ALTER COLUMN occurred_at DROP NOT NULL;
 INSERT INTO public.business_events(job_id,match_method,payload,event_at,occurred_at,attribution_status)
  VALUES(both_null_job,'direct_job_id','{"body":"both clocks null"}',NULL,NULL,'direct');
 missing_after:=(public.context_pipeline_status()->>'missing_event_time')::integer;
 IF missing_after IS DISTINCT FROM missing_before+1 THEN RAISE EXCEPTION 'heartbeat both-null missing_event_time % -> %',missing_before,missing_after; END IF;
END $$;
ROLLBACK;
