-- After the down: the trigger, the four functions and both indexes are gone,
-- the ladder's insert trigger is untouched, and a message row is captured with
-- no party_roles (the behaviour before this migration).
\set ON_ERROR_STOP 1
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='context_party_roles_business_event') THEN
  RAISE EXCEPTION 'party roles rollback: the trigger is still there'; END IF;
 IF to_regprocedure('public.context_party_user_role(text,text)') IS NOT NULL
  OR to_regprocedure('public.context_party_builder_address(text)') IS NOT NULL
  OR to_regprocedure('public.context_message_party_roles(public.business_events)') IS NOT NULL
  OR to_regprocedure('public.context_stamp_party_roles()') IS NOT NULL
 THEN RAISE EXCEPTION 'party roles rollback: a function is still there'; END IF;
 IF to_regclass('public.business_events_writer_marked_contact') IS NOT NULL OR to_regclass('public.jobs_ghl_contact_party_roles') IS NOT NULL
 THEN RAISE EXCEPTION 'party roles rollback: an index is still there'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname='context_attribute_business_event'
   AND t.tgfoid='public.attribute_business_event()'::regprocedure)
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.attribute_business_event()'::regprocedure)<>'d0036a1bc36f4b2a779f4a8b192cd687'
 THEN RAISE EXCEPTION 'party roles rollback: the ladder''s insert trigger changed'; END IF;
END $$;
BEGIN;
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(contact_id,direction,channel,event_type,source,payload,occurred_at,event_at)
  VALUES('pr-rb','inbound','sms','client.reply','party_roles_contract',jsonb_build_object('body','Rollback fixture'),now(),now())
  RETURNING * INTO e;
 IF e.metadata ? 'party_roles' THEN RAISE EXCEPTION 'party roles rollback: a new row still carries party_roles'; END IF;
END $$;
ROLLBACK;
