-- After the down: the rules ladder is L1e's again, byte for byte, with
-- L1e's comment and grants, the rules-off ladder is untouched, and a relinked
-- public-key scope record goes to the bucket with the rules on again (the
-- behaviour this migration removed).
\set ON_ERROR_STOP 1
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'d5af94a0f9320652116cc2b304021ab5'
 THEN RAISE EXCEPTION 'l1f rollback: the rules ladder is not L1e''s'; END IF;
 IF obj_description('public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure,'pg_proc') IS DISTINCT FROM 'L1e: the ladder (P4) as L1d left it (20261005090000: step 1b and the crew and staff rules) plus L1e (20261005170000). Rules off: P1a''s ladder with those and L1e. Rules on: writer check, a service-role outbound row marked recipient_role crew or staff handled by the L1d rule, a row with no words or an automated row keeps a custody job and the job a service-role writer named with no match_method (writer_job), custody with monitor-inbox re-scan, the source''s own payload job unless its writer declared it a guess (bindable: placed, rule payload_job; unbindable: bucket, payload_job_unbindable; guess: payload_job_guess, on to the later rules), identity (payload.from read), references (multi_ref unplaced; one job on an outbound row to a known contact who is not that job''s customer or party: the L1d rule), live thread and supplier order bindings, contact rules with keys and aftercare, exact or loose site address, bucket. Always stamps metadata.bucket_reason on a bucket row. p_preview writes nothing. p_rules_on null reads the flag.'
 THEN RAISE EXCEPTION 'l1f rollback: L1e''s comment is not restored'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
 THEN RAISE EXCEPTION 'l1f rollback: the rules-off ladder changed'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(r,'public.resolve_context_attribution(public.business_events,boolean,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'l1f rollback: % can call the private rules ladder',r; END IF;
 END LOOP;
END $$;
BEGIN;
DO $$
DECLARE j uuid:=gen_random_uuid(); e public.business_events; r public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,created_at) VALUES
  (j,'00000000-0000-0000-0000-000000000001','scheduled','patio','SWP-992099',now()-interval '30 days');
 PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,payload,occurred_at,event_at)
  VALUES('scope.decision','patio-tool','scope',j::text,jsonb_build_object('decision_type','roof_pitch','job_id',j),now()-interval '1 day',now()-interval '1 day')
  RETURNING * INTO e;
 PERFORM set_config('request.jwt.claims','',true);
 UPDATE public.business_events SET job_id=j,match_method='direct_job_id',
  metadata=metadata||jsonb_build_object('source_job_binding',jsonb_build_object('job_id',j,'match_method','direct_job_id','via','writer_key_relink'))
  WHERE id=e.id RETURNING * INTO e;
 r:=public.resolve_context_attribution(e,true,true);
 IF r.job_id IS NOT NULL OR r.metadata->>'placement_rule' IS DISTINCT FROM 'unverified_writer'
 THEN RAISE EXCEPTION 'l1f rollback: L1e''s rules ladder must bucket the relinked record again, got % %',r.attribution_status,r.job_id; END IF;
END $$;
ROLLBACK;
