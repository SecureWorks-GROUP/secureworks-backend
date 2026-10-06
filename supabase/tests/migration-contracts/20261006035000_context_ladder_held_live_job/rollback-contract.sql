-- After the down: the rules ladder is L1f's again, byte for byte, with L1f's
-- comment and grants, the rules-off ladder is untouched, and a row placed
-- before the customer's second job went live goes to review with the rules on
-- again (the behaviour this migration removed).
\set ON_ERROR_STOP 1
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'0870431e8ec3ab2f2e123146298c9727'
 THEN RAISE EXCEPTION 'l1g rollback: the rules ladder is not L1f''s'; END IF;
 -- md5 of L1f's comment text (20261006020000), restored exactly.
 IF md5(obj_description('public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure,'pg_proc')) IS DISTINCT FROM 'c05e13c4ae3c45e3e3391d664f5c8d44'
 THEN RAISE EXCEPTION 'l1g rollback: L1f''s comment is not restored'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
 THEN RAISE EXCEPTION 'l1g rollback: the rules-off ladder changed'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(r,'public.resolve_context_attribution(public.business_events,boolean,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'l1g rollback: % can call the private rules ladder',r; END IF;
 END LOOP;
END $$;
BEGIN;
DO $$
DECLARE ja uuid:=gen_random_uuid(); jb uuid:=gen_random_uuid(); e public.business_events; r public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
  (ja,'00000000-0000-0000-0000-000000000001','quoted','fencing','SWF-993901','hl-rb',now()-interval '4 days');
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,provider_message_id,payload,metadata,occurred_at,event_at)
  VALUES('hl-rb','contact','hl-rb','inbound','sms','client.sms_in','ghl-message-reconcile','ghl:hlrb1','{"body":"About the quote"}',
   '{"capture_mode":"live"}',now()-interval '90 minutes',now()-interval '90 minutes')
  RETURNING * INTO e;
 PERFORM set_config('request.jwt.claims','',true);
 IF e.job_id IS DISTINCT FROM ja OR e.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'l1g rollback: the text must land single_open, got % %',e.attribution_status,e.job_id; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
  (jb,'00000000-0000-0000-0000-000000000001','draft','fencing','SWF-993902','hl-rb',now()-interval '84 minutes');
 UPDATE public.jobs SET status='quoted' WHERE id=jb;
 r:=public.resolve_context_attribution(e,true,true);
 IF r.job_id IS NOT NULL OR r.metadata->>'placement_rule' IS DISTINCT FROM 'review_several'
 THEN RAISE EXCEPTION 'l1g rollback: L1f''s rules ladder must send the row to review again, got % % %',r.attribution_status,r.job_id,r.metadata->>'placement_rule'; END IF;
END $$;
ROLLBACK;
