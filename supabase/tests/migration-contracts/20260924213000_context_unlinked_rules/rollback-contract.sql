-- After the P4 rollback: the ladder and the insert trigger are the live P1a and
-- K1 bodies again, P4's functions are gone, and an insert is still placed.
\set ON_ERROR_STOP 1
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'fe50f14f4ab28d4d6c9dbb70bc85e7df'
 THEN RAISE EXCEPTION 'p4 rollback: the ladder is not the P1a body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.attribute_business_event()'::regprocedure)<>'7c1b8ffeeed8829288ee42c30e4314e5'
 THEN RAISE EXCEPTION 'p4 rollback: the trigger is not the K1 body'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'P4:%') THEN RAISE EXCEPTION 'p4 rollback left a P4 function'; END IF;
 IF has_function_privilege('anon','public.resolve_context_attribution(public.business_events)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.resolve_context_attribution(public.business_events)','EXECUTE')
 THEN RAISE EXCEPTION 'p4 rollback: the ladder ACL is not the live one'; END IF;
END $$;
BEGIN;
INSERT INTO public.jobs(id,org_id,job_number,status,type) VALUES ('d4000000-0000-4000-8000-0000000000aa',gen_random_uuid(),'SWP-99004','scheduled','patio');
INSERT INTO public.business_events(id,event_type,source,payload) VALUES ('d4e00000-0000-4000-8000-0000000000aa','client.sms_in','test','{"body":"about SWP-99004"}');
DO $$ BEGIN
 IF (SELECT attribution_status FROM public.business_events WHERE id='d4e00000-0000-4000-8000-0000000000aa')<>'direct'
  OR (SELECT metadata->>'written_as' FROM public.business_events WHERE id='d4e00000-0000-4000-8000-0000000000aa')<>'service_role'
 THEN RAISE EXCEPTION 'p4 rollback: ladder or writer record no longer works'; END IF;
END $$;
ROLLBACK;
