-- Roll back EM1 (20260924213000_context_email_capture_config).
--
-- Refuses rather than discarding data or a later slice's work. It stops if:
--   - flag email_capture_v2 is on (the new poller may be reading the list);
--   - an inbox_events sighting column holds a value (EM2 has written; roll
--     that back first);
--   - monitored_mailbox_changes holds a receipt (a person changed the list;
--     dropping it would lose who did what. Export it, then delete it by hand
--     with the owner's word, then run this again);
--   - one of EM1's functions is no longer EM1's body (a later slice owns it).
--
-- Then it restores F1b's stub for status block email_capture byte for byte
-- (md5(prosrc) 155104bfb08b8b3c2f98bdec089d4ee4, with F1b's comment, so F1b's
-- own rollback recognises it), drops EM1's functions, the two tables, and the
-- inbox_events sighting columns with their constraints and indexes, and
-- deletes the email_capture_v2 flag row (off). The monitor-inbox pin to its
-- hard-coded list is code and is reverted by PR, not here; it is correct with
-- or without this schema.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE x record; flag_on boolean:=false; sightings boolean:=false; receipts boolean:=false;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_email_capture_status()','39f700ff23752f161c2215ecc500ece8'),
  ('public.context_email_capture_status_at(timestamptz)','3e6866177bdda5f89305aff50206d01d'),
  ('public.context_email_capture_policy()','ae811e23b69cc7ea382ca727d1b61b39'),
  ('public.set_monitored_mailbox(text,boolean,text,text,text)','1c06b0e19359e747c29b921ae7145ac8')) AS t(sig,md5) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(x.sig)) IS DISTINCT FROM x.md5
  THEN RAISE EXCEPTION 'em1_rollback_refused: % is not the EM1 body; roll back its owning slice first',x.sig; END IF;
 END LOOP;
 SELECT coalesce(bool_or(f.enabled),false) INTO flag_on FROM public.feature_flags f WHERE f.flag_name='email_capture_v2';
 IF flag_on THEN RAISE EXCEPTION 'em1_rollback_refused: flag email_capture_v2 is on; turn it off first'; END IF;
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.inbox_events WHERE business_event_id IS NOT NULL OR provider_message_id IS NOT NULL OR folder_kind IS NOT NULL)' INTO sightings;
 IF sightings THEN RAISE EXCEPTION 'em1_rollback_refused: inbox_events sighting columns hold values; roll back the email poller first'; END IF;
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.monitored_mailbox_changes)' INTO receipts;
 IF receipts THEN RAISE EXCEPTION 'em1_rollback_refused: monitored_mailbox_changes holds receipts; export them first'; END IF;
END $$;

-- F1b's stub, byte for byte.
CREATE OR REPLACE FUNCTION public.context_email_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_email_capture_status() IS
 'F1b stub. Status block email_capture, owned by email slice EM1, which replaces this body. Null means not built yet.';
REVOKE ALL ON FUNCTION public.context_email_capture_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_email_capture_status() TO service_role;

DROP FUNCTION IF EXISTS public.context_email_capture_status_at(timestamptz);
DROP FUNCTION IF EXISTS public.context_email_capture_policy();
DROP FUNCTION IF EXISTS public.set_monitored_mailbox(text,boolean,text,text,text);
DROP TABLE IF EXISTS public.monitored_mailbox_changes;
DROP TABLE IF EXISTS public.monitored_mailboxes;

DROP INDEX IF EXISTS public.inbox_events_business_event_id;
DROP INDEX IF EXISTS public.inbox_events_provider_message_id;
ALTER TABLE public.inbox_events DROP CONSTRAINT IF EXISTS inbox_events_business_event_id_fkey;
ALTER TABLE public.inbox_events DROP CONSTRAINT IF EXISTS inbox_events_folder_kind;
ALTER TABLE public.inbox_events DROP CONSTRAINT IF EXISTS inbox_events_provider_message_id;
ALTER TABLE public.inbox_events
 DROP COLUMN IF EXISTS business_event_id,
 DROP COLUMN IF EXISTS provider_message_id,
 DROP COLUMN IF EXISTS folder_kind;

DELETE FROM public.feature_flags WHERE flag_name='email_capture_v2' AND enabled=false;

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_email_capture_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 'em1_rollback: F1b stub not restored'; END IF;
END $$;
