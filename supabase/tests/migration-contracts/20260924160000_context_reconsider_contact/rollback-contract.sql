-- After the down: the live job-created body is back byte for byte, the
-- reconsideration function is gone, and a job insert re-runs the contact's
-- bucket again (the legacy behaviour, no relink stamp).
DO $$
DECLARE live text; org uuid:='00000000-0000-0000-0000-000000000001'; j uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure('public.context_job_created_reconsider()');
 IF live IS DISTINCT FROM '5345aed90185a1e2366f38ee76b3ec36' THEN RAISE EXCEPTION 'rollback: trigger body is %',live; END IF;
 IF to_regprocedure('public.context_reconsider_contact(text,timestamptz,text,uuid)') IS NOT NULL
  OR to_regprocedure('public.context_reconsider_eligible(public.business_events,uuid)') IS NOT NULL
 THEN RAISE EXCEPTION 'rollback: P1b functions remain'; END IF;
 IF has_function_privilege('anon','public.context_job_created_reconsider()','EXECUTE') THEN RAISE EXCEPTION 'rollback: anon can execute the trigger function'; END IF;
 INSERT INTO public.business_events(payload,contact_id,event_at) VALUES('{"body":"Quote please"}','p1b-rb','2026-09-01Z') RETURNING * INTO e;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(j,org,'quoted','fencing','P1B-RB-JOB','p1b-rb','2026-09-05Z');
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.job_id IS DISTINCT FROM j OR e.attribution_status IS DISTINCT FROM 'single_open' OR e.metadata ? 'placement_reconsidered'
 THEN RAISE EXCEPTION 'rollback: legacy re-run not restored, got % %',e.attribution_status,e.metadata; END IF;
 DELETE FROM public.business_events WHERE id=e.id; DELETE FROM public.jobs WHERE id=j;
END $$;
