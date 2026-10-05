-- Down for 20261005200000_context_party_roles: drop the trigger, the four
-- functions and the two indexes. New rows are captured with no
-- metadata.party_roles again. Stamps already on rows are left in place
-- (metadata only, read by nobody once the readers are rolled back); the
-- backfill's own undo removes them.
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS context_party_roles_business_event ON public.business_events;
DROP FUNCTION IF EXISTS public.context_stamp_party_roles();
DROP FUNCTION IF EXISTS public.context_message_party_roles(public.business_events);
DROP FUNCTION IF EXISTS public.context_party_builder_address(text);
DROP FUNCTION IF EXISTS public.context_party_user_role(text,text);
DROP INDEX IF EXISTS public.business_events_writer_marked_contact;
DROP INDEX IF EXISTS public.jobs_ghl_contact_party_roles;
