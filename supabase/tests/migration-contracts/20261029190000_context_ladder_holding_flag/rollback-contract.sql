-- After the down: the nine bodies are their pre-images again (the old
-- holding spelling), with their comments and grants untouched.
DO $$
DECLARE x record; problems text[]:='{}'; r text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_contact_job_timeline(text,timestamptz)','2bc8e76f14fda242eb6e4d414e93fefa','Every job of a GHL contact %',false),
  ('public.context_contact_job_timeline(text,timestamptz,text,text)','f98da204718a4d5ac6395761a963ced4','P4:%',false),
  ('public.context_ref_jobs(text[])','f21ce8cf72292e016daf18d1ee5e9a8c','B0:%',true),
  ('public.context_internal_about_job(public.business_events)','aa53618f6c82998a821b8f7439c75e60','L1d:%',false),
  ('public.context_event_writer_job(public.business_events)','cd36b092818e7607d114d1b3011b3bfd','L1e:%',false),
  ('public.context_job_real(uuid)','9e56ab3916a2522c7fcef3019849e535','Unplaced stage 1 (20261014170000)%',true),
  ('public.context_link_ref_jobs(text)','7c7a9c1330656d02b88caa00a619e5ef','Unplaced stage 1 (20261014170000)%',true),
  ('public.context_builder_ref_jobs(text,jsonb)','9ba7c6a2f309830807fae6cfb4451838','Unplaced stage 1 (20261014170000)%',true),
  ('public.resolve_context_attribution(public.business_events,boolean,boolean)','58fcf93d4c82604822d4ca4b70cc4680','L1g plus unplaced stage 1 (20261014170000)%',false)
 ) AS t(sig,old_md5,note,service_role) LOOP
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig)) IS DISTINCT FROM x.old_md5
  THEN problems:=problems||format('%s is not its pre-image',x.sig); END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig),'pg_proc'),'') NOT LIKE x.note THEN problems:=problems||format('%s lost its comment',x.sig); END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(r,x.sig,'EXECUTE') THEN problems:=problems||format('%s can call %s',r,x.sig); END IF;
  END LOOP;
  IF has_function_privilege('service_role',x.sig,'EXECUTE') IS DISTINCT FROM x.service_role
  THEN problems:=problems||format('the service role grant on %s changed',x.sig); END IF;
 END LOOP;
 -- The restored bodies run.
 IF public.context_job_real(gen_random_uuid()) OR cardinality(public.context_link_ref_jobs('no token here'))<>0
 THEN problems:=problems||'a restored body does not run'::text; END IF;
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'tp04 rollback: %',array_to_string(problems,'; '); END IF;
END $$;
