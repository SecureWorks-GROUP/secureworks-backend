-- After the down migration: the helper is the 20261104095000 body and comment again, service role only, and an empty
-- call from a contact with no job stays empty with its named rule (rolled back).
\set ON_ERROR_STOP 1
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_empty_row_job(public.business_events)'::regprocedure)<>'130b29784228b2542306f5c0e5a5f0e7'
 THEN RAISE EXCEPTION 'c2p rollback: helper md5'; END IF;
 IF coalesce(obj_description('public.context_empty_row_job(public.business_events)'::regprocedure,'pg_proc'),'') NOT LIKE 'C2 known contacts (20261104095000)%'
  OR obj_description('public.context_empty_row_job(public.business_events)'::regprocedure,'pg_proc') LIKE '%C2 place (20261104202000)%'
 THEN RAISE EXCEPTION 'c2p rollback: helper comment'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_function_privilege(r,'public.context_empty_row_job(public.business_events)','EXECUTE') THEN RAISE EXCEPTION 'c2p rollback: % can call the helper',r; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.context_empty_row_job(public.business_events)','EXECUTE') THEN RAISE EXCEPTION 'c2p rollback: service role grant'; END IF;
END $$;
BEGIN;
DO $$
DECLARE e public.business_events;
BEGIN
 UPDATE public.feature_flags SET enabled=true,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.call_complete','ghl-webhook-receiver','call','inbound','2026-09-20 02:00Z','2026-09-20 02:00Z','c2p-rollback-nobody','{"status":"completed"}')
 RETURNING * INTO e;
 IF e.attribution_status<>'empty' OR e.job_id IS NOT NULL OR e.metadata->>'placement_rule' IS DISTINCT FROM 'no_candidate_at_time' OR e.metadata ? 'bucket_reason'
 THEN RAISE EXCEPTION 'c2p rollback: expected empty no_candidate_at_time with no reason, got % % %',e.attribution_status,e.metadata->>'placement_rule',e.metadata->>'bucket_reason'; END IF;
END $$;
ROLLBACK;
