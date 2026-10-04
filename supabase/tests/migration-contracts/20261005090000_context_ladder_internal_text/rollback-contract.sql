-- After the down: both ladder bodies are L1c's again, byte for byte, with
-- L1c's comments and grants, the two helpers are gone, and a crew text by job
-- number is left unplaced for review again (the behaviour this migration
-- replaced).
\set ON_ERROR_STOP 1
DO $$
DECLARE f text; r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'b7d991654bd7d4f2a00136be29ad8fc9'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'9a94bf772e45b23f7f4ffe725a804fc6'
 THEN RAISE EXCEPTION 'l1d rollback: the ladder bodies are not L1c''s'; END IF;
 IF to_regprocedure('public.context_internal_text_role(public.business_events)') IS NOT NULL
  OR to_regprocedure('public.context_internal_about_job(public.business_events)') IS NOT NULL
 THEN RAISE EXCEPTION 'l1d rollback: a helper is still there'; END IF;
 IF (SELECT count(*) FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'L1c:%')<>3
  OR EXISTS (SELECT 1 FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'L1d:%')
 THEN RAISE EXCEPTION 'l1d rollback: L1c''s comments are not restored'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_ladder_p1a(public.business_events,boolean)','public.resolve_context_attribution(public.business_events,boolean,boolean)'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'l1d rollback: % can call private %',r,f; END IF;
  END LOOP;
 END LOOP;
END $$;
BEGIN;
DO $$
DECLARE a uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
  (a,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-990009','ct-rc',now()-interval '60 days');
 INSERT INTO public.business_events(contact_id,direction,channel,event_type,source,payload,occurred_at,event_at)
  VALUES('ct-rcrew','outbound','sms','client.sms_out','internal_text_contract',
   jsonb_build_object('body','New job assigned: SWF-990009 - Rollback Fixture'),now()-interval '1 day',now()-interval '1 day') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'unplaced' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'ref_not_customer'
 THEN RAISE EXCEPTION 'l1d rollback: L1c''s ladder must leave a crew text unplaced again, got % %',e.attribution_status,e.job_id; END IF;
END $$;
ROLLBACK;
