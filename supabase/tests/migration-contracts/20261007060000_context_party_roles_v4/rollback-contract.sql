-- After the down: v3's classifier is back byte for byte (body, comment,
-- grants), the four v4 helpers, row 2's read and the material order index
-- are gone, v2's helpers and the trigger are untouched, and a new message row
-- is stamped party_roles_v3 again (a contact with an open opportunity is
-- unknown to v3).
\set ON_ERROR_STOP 1
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_message_party_roles(public.business_events)'::regprocedure)
   IS DISTINCT FROM '36ed4eac4ec8a1b2efd253da02add409'
  OR coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
   NOT LIKE 'Party roles v3 (20261006034000):%Service role may call it to preview.'
  OR coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'') LIKE '%20261007060000%'
 THEN RAISE EXCEPTION 'party roles v4 rollback: v3''s classifier is not back'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','public'] LOOP
  IF has_function_privilege(r,'public.context_message_party_roles(public.business_events)','EXECUTE') THEN
   RAISE EXCEPTION 'party roles v4 rollback: % can call the classifier',r; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.context_message_party_roles(public.business_events)','EXECUTE') THEN
  RAISE EXCEPTION 'party roles v4 rollback: the service role lost the classifier'; END IF;
 IF to_regprocedure('public.context_party_crm_roles(text,text,text,timestamp with time zone)') IS NOT NULL
  OR to_regprocedure('public.context_party_domain_roles(text)') IS NOT NULL
  OR to_regprocedure('public.context_party_xero_bill(text)') IS NOT NULL
  OR to_regprocedure('public.context_party_call_roles(public.business_events)') IS NOT NULL
  OR to_regprocedure('public.context_party_roles_lanes(timestamp with time zone,integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'party roles v4 rollback: a v4 helper or row 2''s read is still there'; END IF;
 IF to_regclass('public.business_events_party_material_orders') IS NOT NULL THEN
  RAISE EXCEPTION 'party roles v4 rollback: the material order index is still there'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_party_key_roles(text,text)'::regprocedure)<>'4da54e7c7107e927b350947697f440e7'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_party_contact_roles(text)'::regprocedure)<>'8c1f5381cb41d2cdcb0f33b530cc3070'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_stamp_party_roles()'::regprocedure)<>'de974f45ef3174e9391a3d31369df179'
  OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='context_party_roles_business_event' AND tgfoid='public.context_stamp_party_roles()'::regprocedure)
 THEN RAISE EXCEPTION 'party roles v4 rollback: v2''s helpers or the trigger changed'; END IF;
END $$;
BEGIN;
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.sales_booking_packs(resource,week_start,kind,as_of,payload,published_by)
  VALUES('marnin','1970-01-05','roster',now(),jsonb_build_object('opportunities',jsonb_build_array(jsonb_build_object('id','p4-rb-opp',
   'contactId','p4-rb','status','open','createdAt',to_char((now()-interval '2 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))),
   'party_roles_v4_contract');
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,provider_message_id,payload,metadata,occurred_at,event_at)
  VALUES('p4-rb','contact','p4-rb','inbound','sms','client.reply','party_roles_v4_contract','p4:rollback',
   jsonb_build_object('body','Rollback fixture'),'{"capture_mode":"live"}',now(),now())
  RETURNING * INTO e;
 IF e.metadata->'party_roles'->>'version' IS DISTINCT FROM 'party_roles_v3' OR e.metadata->'party_roles'->>'basis' IS DISTINCT FROM 'no_match' THEN
  RAISE EXCEPTION 'party roles v4 rollback: a new row must be stamped by v3 again (an open opportunity is unknown to v3), got %',e.metadata->'party_roles';
 END IF;
END $$;
ROLLBACK;
