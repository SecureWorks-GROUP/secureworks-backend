BEGIN;
DO $$
DECLARE j1 uuid:=gen_random_uuid(); j2 uuid:=gen_random_uuid(); j3 uuid:=gen_random_uuid(); e public.business_events; eid uuid; runid uuid; n integer; t text;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (j1,'00000000-0000-0000-0000-000000000001','accepted','patio','B2-JOB-1','b2-repeat'),
 (j2,'00000000-0000-0000-0000-000000000001','accepted','fencing','B2-JOB-2','b2-repeat');
 -- High confidence is not source provenance, including raw legacy inserts.
 INSERT INTO public.business_events(payload,contact_id,job_id,match_method,match_confidence)
 VALUES('{"body":"Please revise the height"}','b2-repeat',j1,'contact_id',0.99) RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' OR e.metadata->'attribution_hint'->>'job_id'<>j1::text THEN RAISE EXCEPTION 'weak match bypassed ladder'; END IF;
 INSERT INTO public.business_events(payload,contact_id,job_id)
 VALUES('{"body":"Unmarked suggestion"}','b2-repeat',j1) RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' THEN RAISE EXCEPTION 'unmarked job bypassed ladder'; END IF;
 INSERT INTO public.business_events(payload,contact_id,job_id,match_method)
 VALUES('{"body":"Explicit source job"}','b2-repeat',j1,'direct_job_id') RETURNING * INTO e;
 IF e.job_id::text IS DISTINCT FROM j1::text OR e.attribution_status<>'direct' THEN RAISE EXCEPTION 'explicit source binding lost'; END IF;
 INSERT INTO public.business_events(payload,contact_id,thread_key) VALUES('{"body":"Please revise height"}','b2-repeat','b2-thread') RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' THEN RAISE EXCEPTION 'repeat customer must reach Luna, got % %',e.attribution_status,e.payload; END IF;
 eid:=e.id;
 e:=public.attribute_context_event_with_luna(eid,j1,0.91);
 IF e.job_id::text IS DISTINCT FROM j1::text OR e.attribution_status<>'luna' THEN RAISE EXCEPTION 'Luna binding failed'; END IF;
 INSERT INTO public.business_events(payload,thread_key) VALUES('{"body":"The next reply"}','b2-thread') RETURNING * INTO e;
 IF e.job_id::text IS DISTINCT FROM j1::text OR e.attribution_status<>'thread' THEN RAISE EXCEPTION 'thread follow failed'; END IF;
 INSERT INTO public.business_events(payload,contact_id) VALUES('{"body":"Fence height","line":"fencing"}','b2-repeat') RETURNING * INTO e;
 IF e.job_id::text IS DISTINCT FROM j2::text OR e.attribution_status<>'single_line' THEN RAISE EXCEPTION 'single line failed'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Please check B2-JOB-1."}') RETURNING * INTO e;
 IF e.job_id::text IS DISTINCT FROM j1::text OR e.attribution_status<>'direct' THEN RAISE EXCEPTION 'direct number failed: %',e.payload; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Both B2-JOB-1 and B2-JOB-2"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'ambiguous identifiers incorrectly bound'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body_pointer":"private/test-document"}') RETURNING * INTO e;
 IF e.attribution_status<>'empty' OR e.payload->>'body_pointer'<>'private/test-document' THEN RAISE EXCEPTION 'pointer-only evidence lost'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Away","automated":true}') RETURNING * INTO e;
 IF e.attribution_status<>'automated' THEN RAISE EXCEPTION 'automated detection failed'; END IF;
 INSERT INTO public.business_events(payload,contact_id,event_at,context_captured_at) VALUES('{"body":"A prior enquiry"}','b2-future',now()-interval '180 days',NULL) RETURNING * INTO e;
 eid:=e.id;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES(j3,'00000000-0000-0000-0000-000000000001','accepted','patio','B2-JOB-3','b2-future');
 SELECT * INTO e FROM public.business_events WHERE id=eid;
 IF e.job_id::text IS DISTINCT FROM j3::text OR e.attribution_status<>'single_open' THEN RAISE EXCEPTION 'job-created reconsideration must include old bucket evidence'; END IF;
 INSERT INTO public.business_events(payload,occurred_at) VALUES('{"body":"No provider date"}',now()) RETURNING * INTO e;
 IF e.event_at IS NOT NULL THEN RAISE EXCEPTION 'missing provider source date became ingestion date'; END IF;
 INSERT INTO public.business_events(payload,provider_message_id,event_at) VALUES('{"body":"source words"}','ghl:b2-id','2025-01-01Z');
 BEGIN
  INSERT INTO public.business_events(payload,provider_message_id) VALUES('{"body":"duplicate"}','ghl:b2-id');
  RAISE EXCEPTION 'duplicate was accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 UPDATE public.jobs SET status='closed' WHERE id=j3;
 SELECT count(*) INTO n FROM public.context_extraction_candidates(400) WHERE job_id=j3;
 IF n<>0 THEN RAISE EXCEPTION 'old bucket attribution activated historical extraction'; END IF;
 INSERT INTO public.business_events(payload,job_id,match_method,direction) VALUES('{"body":"Fresh closed-job signal"}',j3,'direct_job_id','inbound');
 SELECT count(*) INTO n FROM public.context_extraction_candidates(400) WHERE job_id=j3;
 IF n<>1 THEN RAISE EXCEPTION 'closed job new evidence omitted'; END IF;
 INSERT INTO public.business_events(payload,job_id,direction,match_method) SELECT jsonb_build_object('body','batch event '||v),j3,'inbound','direct_job_id' FROM generate_series(1,30) v;
 SELECT count(*) INTO n FROM public.context_extraction_events(j3,99);
 IF n<>25 THEN RAISE EXCEPTION 'batch must cap at25, got %',n; END IF;
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status) VALUES(j3,current_date,'extraction','running') RETURNING id INTO runid;
 INSERT INTO public.context_extraction_event_receipts(event_id,job_id,extractor_version,run_id) SELECT id,j3,'luna_v2',runid FROM public.context_extraction_events(j3,25);
 SELECT count(*) INTO n FROM public.context_extraction_events(j3,25);
 IF n<>7 THEN RAISE EXCEPTION 'receipt backlog lost, got %',n; END IF;
 -- An outbound tail is readable with a retained inbound anchor, never by itself.
 INSERT INTO public.context_extraction_event_receipts(event_id,job_id,extractor_version,run_id) SELECT id,j3,'luna_v2',runid FROM public.context_extraction_events(j3,25) ON CONFLICT DO NOTHING;
 INSERT INTO public.business_events(payload,job_id,direction,match_method) VALUES('{"body":"Our answer"}',j3,'outbound','direct_job_id');
 SELECT count(*) INTO n FROM public.context_extraction_events(j3,25);
 IF n<>2 THEN RAISE EXCEPTION 'outbound tail lost or sent alone, got %',n; END IF;
 SELECT count(*) INTO n FROM public.context_extraction_candidates(400) WHERE job_id=j3;
 IF n<>1 THEN RAISE EXCEPTION 'outbound tail missing candidate'; END IF;
 UPDATE public.automation_switches SET attribution=false WHERE id=1;
 INSERT INTO public.business_events(payload,job_id,match_method)
 VALUES('{"body":"Explicit source while paused"}',j1,'direct_job_id') RETURNING * INTO e;
 eid:=e.id;
 IF e.job_id IS NOT NULL OR e.metadata->'source_job_binding'->>'job_id'<>j1::text THEN RAISE EXCEPTION 'paused attribution lost explicit source custody'; END IF;
 UPDATE public.automation_switches SET attribution=true WHERE id=1;
 PERFORM public.rerun_context_attribution(250,NULL);
 SELECT * INTO e FROM public.business_events WHERE id=eid;
 IF e.job_id::text IS DISTINCT FROM j1::text OR e.attribution_status<>'direct' THEN RAISE EXCEPTION 'explicit custody did not recover after resume'; END IF;
 UPDATE public.automation_switches SET attribution=false WHERE id=1;
 INSERT INTO public.business_events(payload,job_id) VALUES('{"body":"retained while off"}',j1) RETURNING * INTO e;
 IF e.attribution_status<>'admin_bucket' OR e.job_id IS NOT NULL THEN RAISE EXCEPTION 'attribution switch did not close'; END IF;
 IF public.rerun_context_attribution(250,NULL)<>0 THEN RAISE EXCEPTION 'rerun ignored switch'; END IF;
 IF has_function_privilege('authenticated','public.attribute_context_event_with_luna(uuid,uuid,numeric)','EXECUTE') THEN RAISE EXCEPTION 'public Luna RPC'; END IF;
END $$;
ROLLBACK;

-- A retry already owns today's budget slot and must remain discoverable when
-- older unadmitted jobs exceed a candidate page.
BEGIN;
DO $$
DECLARE older_job uuid:=gen_random_uuid(); retry_job uuid:=gen_random_uuid(); selected_job uuid;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (older_job,'00000000-0000-0000-0000-000000000001','accepted','patio','B2-FAIR-OLD','b2-fair-old'),
 (retry_job,'00000000-0000-0000-0000-000000000001','accepted','patio','B2-FAIR-RETRY','b2-fair-retry');
 INSERT INTO public.business_events(payload,job_id,event_at,direction,match_method) VALUES
 ('{"body":"Older unadmitted evidence"}',older_job,'2000-01-01Z','inbound','direct_job_id'),
 ('{"body":"Retry evidence"}',retry_job,'2099-01-01Z','inbound','direct_job_id');
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status)
 VALUES(retry_job,(now() AT TIME ZONE 'Australia/Perth')::date,'extraction','failed');
 SELECT job_id INTO selected_job FROM public.context_extraction_candidates(1);
 IF selected_job IS DISTINCT FROM retry_job THEN RAISE EXCEPTION 'budgeted retry hidden behind unadmitted work'; END IF;
END $$;
ROLLBACK;
