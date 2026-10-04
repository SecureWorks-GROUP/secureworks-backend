-- After the down: both ladder bodies are L1b's again, byte for byte, with
-- L1b's comments and grants, the helper is gone, and a crew text by job
-- number is placed on the customer's job again (the behaviour this migration
-- removed).
\set ON_ERROR_STOP 1
DO $$
DECLARE f text; r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'6a45c9ea9a68c8c5899fba45b44e18b5'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'a0205f1a17ae9866ca4c8e57ff2746e4'
 THEN RAISE EXCEPTION 'l1c rollback: the ladder bodies are not L1b''s'; END IF;
 IF to_regprocedure('public.context_ref_recipient_is_customer(public.business_events,uuid)') IS NOT NULL
 THEN RAISE EXCEPTION 'l1c rollback: the helper is still there'; END IF;
 IF (SELECT count(*) FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'L1b:%')<>2
  OR EXISTS (SELECT 1 FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'L1c:%')
 THEN RAISE EXCEPTION 'l1c rollback: L1b''s comments are not restored'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_ladder_p1a(public.business_events,boolean)','public.resolve_context_attribution(public.business_events,boolean,boolean)'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'l1c rollback: % can call private %',r,f; END IF;
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
  VALUES('ct-rcrew','outbound','sms','client.sms_out','non_customer_contract',
   jsonb_build_object('body','New job assigned: SWF-990009 - Rollback Fixture'),now()-interval '1 day',now()-interval '1 day') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM a OR e.attribution_status<>'direct'
 THEN RAISE EXCEPTION 'l1c rollback: L1b''s ladder must place a reference row again, got % %',e.attribution_status,e.job_id; END IF;
END $$;
ROLLBACK;
