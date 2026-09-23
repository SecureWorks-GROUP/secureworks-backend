BEGIN;
DO $$
DECLARE
 org uuid:='00000000-0000-0000-0000-000000000001';
 draft_job uuid:=gen_random_uuid(); quoted_job uuid:=gen_random_uuid();
 closed_job uuid:=gen_random_uuid(); name_job uuid:=gen_random_uuid();
 brief_job uuid:=gen_random_uuid();
 e public.business_events; eid uuid; ev jsonb;
 claimed jsonb; run uuid; tok uuid; result jsonb; facts jsonb; fact uuid;
 d date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 source_time timestamptz:=now()-interval '2 hours';
 first_id uuid; second_id uuid; n int;
 twin_draft_a uuid:=gen_random_uuid(); twin_draft_b uuid:=gen_random_uuid();
BEGIN
 IF to_regprocedure('public.ensure_booking_draft_job(text,text,uuid,jsonb)') IS NULL
  OR to_regprocedure('public.context_contact_jobs(text)') IS NULL
 THEN RAISE EXCEPTION 'booking draft ladder functions missing'; END IF;
 IF has_function_privilege('anon','public.ensure_booking_draft_job(text,text,uuid,jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.ensure_booking_draft_job(text,text,uuid,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'booking draft mint is public'; END IF;
 IF NOT has_function_privilege('service_role','public.ensure_booking_draft_job(text,text,uuid,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'booking draft mint not granted to service_role'; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM pg_indexes
  WHERE schemaname='public' AND indexname='jobs_booking_intake_draft_ghl_contact_id'
 ) THEN RAISE EXCEPTION 'booking draft unique index missing'; END IF;
 -- persist nine-arg must stay beside the five-arg overload.
 IF (SELECT count(*) FROM pg_proc WHERE proname='persist_luna_context_revision')<>2
 THEN RAISE EXCEPTION 'persist overload count changed'; END IF;

 -- Draft single-match pins. Coverage already counted this job; the ladder did not.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id)
  VALUES(draft_job,org,'draft','fencing','BK-DRAFT-'||draft_job,'ghl-draft-only');
 INSERT INTO public.business_events(payload,contact_id)
  VALUES('{"body":"Address is 10 Armand Drive"}','ghl-draft-only') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM draft_job OR e.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'draft single-match must pin, got % %',e.attribution_status,e.job_id; END IF;

 -- A leftover intake draft must not compete with a live job.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id)
  VALUES(quoted_job,org,'quoted','patio','BK-QUOTED-'||quoted_job,'ghl-draft-only');
 INSERT INTO public.business_events(payload,contact_id)
  VALUES('{"body":"Can we move the visit"}','ghl-draft-only') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM quoted_job OR e.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'draft plus live job must pin the live job, got % %',e.attribution_status,e.job_id; END IF;

 -- Two drafts and no live job still go to the Luna pick path.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id)
  VALUES(twin_draft_a,org,'draft','fencing','BK-TWIN-A-'||twin_draft_a,'ghl-two-drafts'),
        (twin_draft_b,org,'draft','patio','BK-TWIN-B-'||twin_draft_b,'ghl-two-drafts');
 INSERT INTO public.business_events(payload,contact_id)
  VALUES('{"body":"Which visit is this"}','ghl-two-drafts') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna'
 THEN RAISE EXCEPTION 'two drafts must go to luna pick, got % %',e.attribution_status,e.job_id; END IF;
 e:=public.attribute_context_event_with_luna(e.id,twin_draft_a,0.9);
 IF e.job_id IS DISTINCT FROM twin_draft_a OR e.attribution_status<>'luna'
 THEN RAISE EXCEPTION 'luna pick of a draft candidate failed % %',e.attribution_status,e.job_id; END IF;

 -- Name-only similarity never pins. The Alisa finding: same words, wrong person.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,client_name)
  VALUES(name_job,org,'draft','fencing','BK-NAME-'||name_job,'ghl-ellie','Alisa Deshon');
 INSERT INTO public.business_events(payload)
  VALUES('{"body":"Hi Alisa, thanks for the enquiry in Sorrento"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.contact_id IS NOT NULL
  OR e.attribution_status NOT IN ('admin_bucket')
 THEN RAISE EXCEPTION 'name-only similarity pinned, got % job=% contact=%',e.attribution_status,e.job_id,e.contact_id; END IF;

 -- Closed-only contact stays unpinned (none).
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id)
  VALUES(closed_job,org,'closed','fencing','BK-CLOSED-'||closed_job,'ghl-closed-only');
 INSERT INTO public.business_events(payload,contact_id)
  VALUES('{"body":"Please come back"}','ghl-closed-only') RETURNING * INTO e;
 IF e.job_id IS NOT NULL
 THEN RAISE EXCEPTION 'closed-only contact must stay unpinned, got %',e.job_id; END IF;

 -- job_brief persists onto job_context, is current, and does not expire.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id)
  VALUES(brief_job,org,'draft','fencing','BK-BRIEF-'||brief_job,'ghl-brief');
 INSERT INTO public.business_events(job_id,match_method,direction,payload,event_at)
  VALUES(brief_job,'direct_job_id','inbound','{"body":"10 Armand Drive, Friday 1:30pm works."}',source_time)
  RETURNING id,to_jsonb(business_events) INTO eid,ev;
 claimed:=public.claim_context_extraction_run(brief_job,d,'extraction');
 run:=(claimed->'run'->>'id')::uuid; tok:=(claimed->'run'->>'lease_token')::uuid;
 facts:=jsonb_build_array(jsonb_build_object(
  'kind','job_brief','text','Where it stands: booked Friday 1:30pm at 10 Armand Drive.','confidence',0.9,
  'source_event_ids',jsonb_build_array(eid),'evidence_excerpt','10 Armand Drive'));
 result:=public.persist_luna_context_revision(run,tok,brief_job,jsonb_build_array(ev),facts,'[]','[]');
 IF result->>'outcome'<>'inserted' OR (result->>'facts_new')::int<>1
 THEN RAISE EXCEPTION 'job_brief did not persist %',result; END IF;
 fact:=(result->'fact_ids'->>0)::uuid;
 IF NOT EXISTS (
  SELECT 1 FROM public.job_context
  WHERE id=fact AND kind='job_brief' AND trust='luna' AND extractor_version='luna_v2'
   AND expires_at IS NULL AND lifecycle='current' AND job_id=brief_job
 ) THEN RAISE EXCEPTION 'job_brief row missing or expired'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.current_job_context_facts WHERE id=fact AND kind='job_brief')
 THEN RAISE EXCEPTION 'job_brief hidden from current_job_context_facts'; END IF;
 IF public.context_fact_expiry('job_brief',source_time) IS NOT NULL
 THEN RAISE EXCEPTION 'job_brief must not auto-expire'; END IF;

 -- Unknown kind still refused.
 -- A separate day slot (K1 also holds a job for 30 minutes after a run starts).
 UPDATE public.context_extraction_runs SET run_date=d-1,started_at=started_at-interval '1 day' WHERE id=run;
 INSERT INTO public.business_events(job_id,match_method,direction,payload,event_at)
  VALUES(brief_job,'direct_job_id','inbound','{"body":"A later note"}',now())
  RETURNING id,to_jsonb(business_events) INTO eid,ev;
 claimed:=public.claim_context_extraction_run(brief_job,d,'extraction');
 run:=(claimed->'run'->>'id')::uuid; tok:=(claimed->'run'->>'lease_token')::uuid;
 BEGIN
  PERFORM public.persist_luna_context_revision(run,tok,brief_job,jsonb_build_array(ev),
   jsonb_build_array(jsonb_build_object('kind','site_address','text','10 Armand','confidence',0.9,'source_event_ids',jsonb_build_array(eid))),
   '[]','[]');
  RAISE EXCEPTION 'unknown kind accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_fact_shape_invalid' THEN RAISE; END IF; END;

 -- Draft mint is idempotent on ghl_contact_id and never matches a name.
 result:=public.ensure_booking_draft_job('ghlContactA1B2C3D4');
 IF result->>'outcome'<>'created' OR (result->>'created')::boolean IS DISTINCT FROM true
  OR result->>'status'<>'draft' OR result->>'job_id' IS NULL
 THEN RAISE EXCEPTION 'draft create failed %',result; END IF;
 first_id:=(result->>'job_id')::uuid;
 result:=public.ensure_booking_draft_job('ghlContactA1B2C3D4');
 IF result->>'outcome'<>'existing' OR (result->>'created')::boolean IS DISTINCT FROM false
  OR (result->>'job_id')::uuid IS DISTINCT FROM first_id
 THEN RAISE EXCEPTION 'draft create was not idempotent %',result; END IF;
 SELECT count(*) INTO n FROM public.jobs WHERE ghl_contact_id='ghlContactA1B2C3D4';
 IF n<>1 THEN RAISE EXCEPTION 'draft mint duplicated contact, count %',n; END IF;
 result:=public.ensure_booking_draft_job('ghl-draft-only');
 IF result->>'outcome'<>'existing' OR (result->>'created')::boolean IS DISTINCT FROM false
  OR (result->>'job_id')::uuid IS DISTINCT FROM quoted_job
 THEN RAISE EXCEPTION 'draft plus live job should reuse the live job %',result; END IF;
 result:=public.ensure_booking_draft_job('ghl-two-drafts');
 IF result->>'outcome'<>'ambiguous' OR (result->>'created')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'two drafts and no live job should be ambiguous %',result; END IF;
 -- Name-shaped input is refused; a name is not a contact id.
 BEGIN
  PERFORM public.ensure_booking_draft_job('Alisa Deshon');
  RAISE EXCEPTION 'name accepted as contact id' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'booking_draft_contact_required' THEN RAISE; END IF; END;

 -- A closed-only contact may receive a new draft; the closed row is not reused.
 result:=public.ensure_booking_draft_job('ghl-closed-only');
 IF result->>'outcome'<>'created' OR (result->>'job_id')::uuid IS NOT DISTINCT FROM closed_job
 THEN RAISE EXCEPTION 'closed contact must mint a new draft %',result; END IF;
 second_id:=(result->>'job_id')::uuid;
 result:=public.ensure_booking_draft_job('ghl-closed-only');
 IF (result->>'job_id')::uuid IS DISTINCT FROM second_id OR result->>'outcome'<>'existing'
 THEN RAISE EXCEPTION 'new draft for closed contact was not idempotent %',result; END IF;
END $$;
ROLLBACK;
