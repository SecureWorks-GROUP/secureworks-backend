-- After the down: #962's classifier is back byte for byte (body, comment,
-- grants), v2's helpers and indexes are gone, #962's helpers and trigger are
-- untouched, and a new message row is stamped party_roles_v1 again.
\set ON_ERROR_STOP 1
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_message_party_roles(public.business_events)'::regprocedure)<>'786fa5e9c40aa3845184fe78519fb5ee'
  OR coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'') NOT LIKE 'Party roles (20261005200000):%'
 THEN RAISE EXCEPTION 'party roles v2 rollback: #962''s classifier is not back'; END IF;
 IF has_function_privilege('anon','public.context_message_party_roles(public.business_events)','EXECUTE')
  OR has_function_privilege('authenticated','public.context_message_party_roles(public.business_events)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_message_party_roles(public.business_events)','EXECUTE')
 THEN RAISE EXCEPTION 'party roles v2 rollback: the classifier''s grants are not #962''s'; END IF;
 IF to_regprocedure('public.context_party_supplier_key(text,text)') IS NOT NULL
  OR to_regprocedure('public.context_party_key_roles(text,text)') IS NOT NULL
  OR to_regprocedure('public.context_party_contact_roles(text)') IS NOT NULL
 THEN RAISE EXCEPTION 'party roles v2 rollback: a v2 helper is still there'; END IF;
 IF to_regclass('public.business_events_party_contact_keys') IS NOT NULL OR to_regclass('public.business_events_party_lead_contact') IS NOT NULL
  OR to_regclass('public.business_events_party_mail_from') IS NOT NULL
 THEN RAISE EXCEPTION 'party roles v2 rollback: a v2 index is still there'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_party_user_role(text,text)'::regprocedure)<>'17bdaa22bb55de8635c1dd8563d070d1'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_party_builder_address(text)'::regprocedure)<>'ccd5e9acd5d51228007c3af14054c474'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_stamp_party_roles()'::regprocedure)<>'de974f45ef3174e9391a3d31369df179'
  OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='context_party_roles_business_event' AND tgfoid='public.context_stamp_party_roles()'::regprocedure)
 THEN RAISE EXCEPTION 'party roles v2 rollback: #962''s helpers or trigger changed'; END IF;
END $$;
BEGIN;
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.contact_matches(ghl_contact_id) VALUES('p2-rb');
 INSERT INTO public.business_events(contact_id,direction,channel,event_type,source,payload,occurred_at,event_at)
  VALUES('p2-rb','inbound','sms','client.reply','party_roles_v2_contract',jsonb_build_object('body','Rollback fixture'),now(),now())
  RETURNING * INTO e;
 IF e.metadata->'party_roles'->>'version' IS DISTINCT FROM 'party_roles_v1' OR e.metadata->'party_roles'->>'basis' IS DISTINCT FROM 'no_match' THEN
  RAISE EXCEPTION 'party roles v2 rollback: a new row must read v1 again (a lead is unknown to v1), got %',e.metadata->'party_roles'; END IF;
END $$;
ROLLBACK;
