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
 IF e.job_id<>j1 OR e.attribution_status<>'direct' THEN RAISE EXCEPTION 'explicit source binding lost'; END IF;
 INSERT INTO public.business_events(payload,contact_id,thread_key) VALUES('{"body":"Please revise height"}','b2-repeat','b2-thread') RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' THEN RAISE EXCEPTION 'repeat customer must reach Luna, got % %',e.attribution_status,e.payload; END IF;
 eid:=e.id;
 e:=public.attribute_context_event_with_luna(eid,j1,0.91);
 IF e.job_id<>j1 OR e.attribution_status<>'luna' THEN RAISE EXCEPTION 'Luna binding failed'; END IF;
 INSERT INTO public.business_events(payload,thread_key) VALUES('{"body":"The next reply"}','b2-thread') RETURNING * INTO e;
 IF e.job_id<>j1 OR e.attribution_status<>'thread' THEN RAISE EXCEPTION 'thread follow failed'; END IF;
 INSERT INTO public.business_events(payload,contact_id) VALUES('{"body":"Fence height","line":"fencing"}','b2-repeat') RETURNING * INTO e;
 IF e.job_id<>j2 OR e.attribution_status<>'single_line' THEN RAISE EXCEPTION 'single line failed'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Please check B2-JOB-1."}') RETURNING * INTO e;
 IF e.job_id<>j1 OR e.attribution_status<>'direct' THEN RAISE EXCEPTION 'direct number failed: %',e.payload; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Both B2-JOB-1 and B2-JOB-2"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'ambiguous identifiers incorrectly bound'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body_pointer":"private/test-document"}') RETURNING * INTO e;
 IF e.attribution_status<>'empty' OR e.payload->>'body_pointer'<>'private/test-document' THEN RAISE EXCEPTION 'pointer-only evidence lost'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Away","automated":true}') RETURNING * INTO e;
 IF e.attribution_status<>'automated' THEN RAISE EXCEPTION 'automated detection failed'; END IF;
 -- Since P1a (20260924140000, sms.md rule 6) a new job takes only bucket evidence
 -- inside its 30-day lead window; a 180-day-old enquiry stays before any job.
 INSERT INTO public.business_events(payload,contact_id,event_at,context_captured_at) VALUES('{"body":"A prior enquiry"}','b2-future',now()-interval '10 days',NULL) RETURNING * INTO e;
 eid:=e.id;
 INSERT INTO public.business_events(payload,contact_id,event_at,context_captured_at) VALUES('{"body":"A much older enquiry"}','b2-future',now()-interval '180 days',NULL) RETURNING id INTO runid;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES(j3,'00000000-0000-0000-0000-000000000001','accepted','patio','B2-JOB-3','b2-future');
 SELECT * INTO e FROM public.business_events WHERE id=eid;
 IF e.job_id<>j3 OR e.attribution_status<>'single_open' THEN RAISE EXCEPTION 'job-created reconsideration must include old bucket evidence'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=runid;
 IF to_regprocedure('public.context_contact_jobs_at(text,timestamptz)') IS NOT NULL AND (e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket')
 THEN RAISE EXCEPTION 'evidence outside the lead window placed on a new job'; END IF;
 runid:=NULL;
 INSERT INTO public.business_events(payload,occurred_at) VALUES('{"body":"No provider date"}',now()) RETURNING * INTO e;
 IF e.event_at IS NOT NULL THEN RAISE EXCEPTION 'missing provider source date became ingestion date'; END IF;
 INSERT INTO public.business_events(payload,provider_message_id,event_at) VALUES('{"body":"source words"}','ghl:b2-id','2025-01-01Z');
 BEGIN
  INSERT INTO public.business_events(payload,provider_message_id) VALUES('{"body":"duplicate"}','ghl:b2-id');
  RAISE EXCEPTION 'duplicate was accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 UPDATE public.jobs SET status='closed' WHERE id=j3;
 -- K1 (20260924030000) replaced the candidates rule; waking evidence is the
 -- measure. An old row placed by the job-created re-run never wakes.
 SELECT (public.context_job_cadence(j3)->>'waking_count')::int INTO n;
 IF n<>0 THEN RAISE EXCEPTION 'old bucket attribution activated historical extraction'; END IF;
 INSERT INTO public.business_events(payload,job_id,match_method,direction) VALUES('{"body":"Fresh closed-job signal"}',j3,'direct_job_id','inbound');
 SELECT (public.context_job_cadence(j3)->>'waking_count')::int INTO n;
 IF n<>1 THEN RAISE EXCEPTION 'closed job new evidence omitted'; END IF;
 INSERT INTO public.business_events(payload,job_id,direction,match_method) SELECT jsonb_build_object('body','batch event '||v),j3,'inbound','direct_job_id' FROM generate_series(1,30) v;
 SELECT count(*) INTO n FROM public.context_extraction_events(j3,99);
 IF n<>25 THEN RAISE EXCEPTION 'batch must cap at25, got %',n; END IF;
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status) VALUES(j3,current_date,'extraction','running') RETURNING id INTO runid;
 INSERT INTO public.context_extraction_event_receipts(event_id,job_id,extractor_version,run_id) SELECT id,j3,'luna_v2',runid FROM public.context_extraction_events(j3,25);
 SELECT count(*) INTO n FROM public.context_extraction_events(j3,25);
 IF n<>7 THEN RAISE EXCEPTION 'receipt backlog lost, got %',n; END IF;
 -- K1 (20260924030000) superseded D4 (20260916120100): our own outbound
 -- messages are evidence and wake a read on their own (cadence.md section 1).
 INSERT INTO public.context_extraction_event_receipts(event_id,job_id,extractor_version,run_id) SELECT id,j3,'luna_v2',runid FROM public.context_extraction_events(j3,25) ON CONFLICT DO NOTHING;
 INSERT INTO public.business_events(payload,job_id,direction,match_method) VALUES('{"body":"Our answer"}',j3,'outbound','direct_job_id');
 SELECT count(*) INTO n FROM public.context_extraction_events(j3,25);
 IF n<>1 THEN RAISE EXCEPTION 'outbound message not read on its own, got %',n; END IF;
 SELECT (public.context_job_cadence(j3)->>'waking_count')::int INTO n;
 IF n<>1 THEN RAISE EXCEPTION 'outbound message does not wake the job'; END IF;
 INSERT INTO public.business_events(payload,job_id,direction,match_method) VALUES('{"body":"Client follow-up"}',j3,'inbound','direct_job_id');
 SELECT count(*) INTO n FROM public.context_extraction_events(j3,25);
 IF n<>2 THEN RAISE EXCEPTION 'outbound tail lost beside new inbound, got %',n; END IF;
 SELECT (public.context_job_cadence(j3)->>'waking_count')::int INTO n;
 IF n<>2 THEN RAISE EXCEPTION 'new inbound missing from waking evidence'; END IF;
 UPDATE public.automation_switches SET attribution=false WHERE id=1;
 INSERT INTO public.business_events(payload,job_id,match_method)
 VALUES('{"body":"Explicit source while paused"}',j1,'direct_job_id') RETURNING * INTO e;
 eid:=e.id;
 IF e.job_id IS NOT NULL OR e.metadata->'source_job_binding'->>'job_id'<>j1::text THEN RAISE EXCEPTION 'paused attribution lost explicit source custody'; END IF;
 UPDATE public.automation_switches SET attribution=true WHERE id=1;
 PERFORM public.rerun_context_attribution(250,NULL);
 SELECT * INTO e FROM public.business_events WHERE id=eid;
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'direct' THEN RAISE EXCEPTION 'explicit custody did not recover after resume'; END IF;
 UPDATE public.automation_switches SET attribution=false WHERE id=1;
 INSERT INTO public.business_events(payload,job_id) VALUES('{"body":"retained while off"}',j1) RETURNING * INTO e;
 IF e.attribution_status<>'admin_bucket' OR e.job_id IS NOT NULL THEN RAISE EXCEPTION 'attribution switch did not close'; END IF;
 IF public.rerun_context_attribution(250,NULL)<>0 THEN RAISE EXCEPTION 'rerun ignored switch'; END IF;
 IF has_function_privilege('authenticated','public.attribute_context_event_with_luna(uuid,uuid,numeric)','EXECUTE') THEN RAISE EXCEPTION 'public Luna RPC'; END IF;
END $$;
ROLLBACK;

-- The retry-first candidate order was replaced by K1 (20260924030000): fewest
-- runs today first, then oldest waking evidence first. Its contract (section 4)
-- owns the order now.
