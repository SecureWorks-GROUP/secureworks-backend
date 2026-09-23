-- After the down: the four live bodies are back byte for byte, the at-time
-- functions are gone, and the ladder uses today's open jobs again.
DO $$
DECLARE x record; live text; org uuid:='00000000-0000-0000-0000-000000000001'; j uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.resolve_context_attribution(public.business_events)','acb80ebe792beeb7e5b537643bf9f184'),
  ('public.rerun_context_attribution(integer,text)','e55811ae70e8643c3fdfc72c8741b471'),
  ('public.attribute_context_event_with_luna(uuid,uuid,numeric)','48eabf7e132092cd225ff5060ce58846'),
  ('public.attribute_context_event_with_luna(uuid,uuid,numeric,text)','407832111a538b414897fa0b359232d2')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'rollback: % is %',x.sig,live; END IF;
 END LOOP;
 IF to_regprocedure('public.context_contact_jobs_at(text,timestamptz)') IS NOT NULL
  OR to_regprocedure('public.context_contact_job_timeline(text,timestamptz)') IS NOT NULL
  OR to_regprocedure('public.context_event_is_ghl(public.business_events)') IS NOT NULL
 THEN RAISE EXCEPTION 'rollback: P1a functions remain'; END IF;
 IF has_function_privilege('anon','public.resolve_context_attribution(public.business_events)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.attribute_context_event_with_luna(uuid,uuid,numeric)','EXECUTE')
 THEN RAISE EXCEPTION 'rollback: grants not restored'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(j,org,'quoted','fencing','P1A-RB-JOB','p1a-rb','2026-08-14Z');
 INSERT INTO public.business_events(payload,contact_id,event_at) VALUES('{"body":"Old text"}','p1a-rb','2026-07-03Z') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM j OR e.attribution_status<>'single_open' THEN RAISE EXCEPTION 'rollback: open-jobs ladder not restored, got %',e.attribution_status; END IF;
 DELETE FROM public.business_events WHERE id=e.id; DELETE FROM public.jobs WHERE id=j;
END $$;
