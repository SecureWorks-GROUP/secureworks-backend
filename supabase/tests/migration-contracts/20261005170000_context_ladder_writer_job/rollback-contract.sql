-- After the down: both ladder bodies are L1d's again, byte for byte, with
-- L1d's comments and grants, the repair classifier is 20261002170100's, the
-- helpers are gone, and a payment record whose writer named its job with no
-- match_method lands on no job again (the behaviour this migration removed).
\set ON_ERROR_STOP 1
DO $$
DECLARE f text; r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'e11321e9d986be1e83f05e95f3efc36c'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'90c038b5f48677af4598e475e2583572'
 THEN RAISE EXCEPTION 'l1e rollback: the ladder bodies are not L1d''s'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_payload_job_mismatch_rows()'::regprocedure)<>'3c7759191b5f51dfeaabab87ae2c4cdb'
 THEN RAISE EXCEPTION 'l1e rollback: the repair classifier is not 20261002170100''s'; END IF;
 IF to_regprocedure('public.context_event_writer_job(public.business_events)') IS NOT NULL
  OR to_regprocedure('public.context_payload_job_is_guess(public.business_events)') IS NOT NULL
 THEN RAISE EXCEPTION 'l1e rollback: a helper is still there'; END IF;
 IF (SELECT count(*) FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'L1d:%' AND p.proname IN ('context_ladder_p1a','resolve_context_attribution'))<>2
  OR EXISTS (SELECT 1 FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'L1e:%')
 THEN RAISE EXCEPTION 'l1e rollback: L1d''s comments are not restored'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_ladder_p1a(public.business_events,boolean)','public.resolve_context_attribution(public.business_events,boolean,boolean)'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'l1e rollback: % can call private %',r,f; END IF;
  END LOOP;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.context_payload_job_mismatch_rows()','EXECUTE')
 THEN RAISE EXCEPTION 'l1e rollback: the service role lost the repair classifier'; END IF;
END $$;
BEGIN;
DO $$
DECLARE a uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
  (a,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-991009','wj-rc',now()-interval '60 days');
 INSERT INTO public.business_events(job_id,event_type,source,entity_type,entity_id,payload,occurred_at,event_at)
  VALUES(a,'invoice.paid','xero-sync-trigger','invoice','wj-rollback','{"invoice_number":"INV-99009"}',now()-interval '1 day',now()-interval '1 day')
  RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'empty' OR e.metadata->'attribution_hint'->>'job_id' IS DISTINCT FROM a::text
 THEN RAISE EXCEPTION 'l1e rollback: L1d''s ladder must strip a writer job again, got % %',e.attribution_status,e.job_id; END IF;
END $$;
ROLLBACK;
