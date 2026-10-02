-- After the down: both ladder bodies are P4's again, byte for byte, with P4's
-- comments and grants, and a payload row is decided by the contact rules as
-- before (the behaviour this migration removed).
\set ON_ERROR_STOP 1
DO $$
DECLARE f text; r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'9ce621de1f295757e9ed83abdc2f3765'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'e04d9e81649364b8e9acc38f14833ba2'
 THEN RAISE EXCEPTION 'l1b rollback: the ladder bodies are not P4''s'; END IF;
 IF (SELECT count(*) FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'P4:%')<>10
  OR EXISTS (SELECT 1 FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'L1b:%')
 THEN RAISE EXCEPTION 'l1b rollback: P4''s comments are not restored'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_ladder_p1a(public.business_events,boolean)','public.resolve_context_attribution(public.business_events,boolean,boolean)'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'l1b rollback: % can call private %',r,f; END IF;
  END LOOP;
 END LOOP;
END $$;
BEGIN;
DO $$
DECLARE a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
  (a,'00000000-0000-0000-0000-000000000001','scheduled','fencing','PJ-RA','pj-rc',now()-interval '60 days'),
  (b,'00000000-0000-0000-0000-000000000001','scheduled','fencing','PJ-RB','pj-rother',now()-interval '60 days');
 INSERT INTO public.business_events(contact_id,direction,event_type,source,payload,occurred_at,event_at)
  VALUES('pj-rc','inbound','client.sms_in','payload_job_contract',jsonb_build_object('job_id',b::text,'body','Rollback fixture text'),
   now()-interval '1 day',now()-interval '1 day') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM a OR e.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'l1b rollback: P4''s ladder must decide a payload row by the contact rules again, got % %',e.attribution_status,e.job_id; END IF;
END $$;
ROLLBACK;
