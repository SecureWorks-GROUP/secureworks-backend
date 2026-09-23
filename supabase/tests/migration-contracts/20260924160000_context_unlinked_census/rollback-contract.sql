-- After the B0 rollback: every B0 function and jobs index is gone, and the
-- ladder, candidate set and insert trigger are the P1a objects, untouched.
\set ON_ERROR_STOP 1
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'B0:%') THEN RAISE EXCEPTION 'b0 rollback left a B0 function'; END IF;
 IF EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='jobs' AND indexname LIKE 'jobs_context_%') THEN RAISE EXCEPTION 'b0 rollback left a jobs index'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'fe50f14f4ab28d4d6c9dbb70bc85e7df'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_contact_jobs_at(text,timestamptz)'::regprocedure)<>'911811b617fa760f5ddf847fb1ab853d'
 THEN RAISE EXCEPTION 'b0 rollback: the ladder is not the P1a body'; END IF;
END $$;
-- The legacy surface still works: an insert is still placed by the ladder.
BEGIN;
INSERT INTO public.jobs(id,org_id,job_number,status,type) VALUES ('b0000000-0000-4000-8000-0000000000aa',gen_random_uuid(),'SWP-99001','scheduled','patio');
INSERT INTO public.business_events(id,event_type,source,payload) VALUES ('b0e00000-0000-4000-8000-0000000000aa','client.sms_in','test','{"body":"about SWP-99001"}');
DO $$ BEGIN
 IF (SELECT attribution_status FROM public.business_events WHERE id='b0e00000-0000-4000-8000-0000000000aa')<>'direct' THEN RAISE EXCEPTION 'b0 rollback: ladder no longer places'; END IF;
END $$;
ROLLBACK;
