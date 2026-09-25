-- Roll back EM1 (20260924213000_context_email_capture_config).
--
-- Refuses rather than discarding data or a later slice's work. It stops if:
--   - flag email_capture_v2 is on (the new poller may be reading the list);
--   - an inbox_events sighting column holds a value (EM2 has written; roll
--     that back first);
--   - monitored_mailbox_changes holds a receipt (a person changed the list;
--     dropping it would lose who did what. Export it, then delete it by hand
--     with the owner's word, then run this again);
--   - monitored_mailboxes holds a row this migration did not seed;
--   - one of EM1's functions is no longer EM1's body (a later slice owns it).
--
-- Then it restores what production had before EM1:
--   - F1b's stub for status block email_capture, byte for byte (md5(prosrc)
--     155104bfb08b8b3c2f98bdec089d4ee4, with F1b's comment, so F1b's own
--     rollback recognises it);
--   - the T7 draft monitored_mailboxes, empty: the seed deleted, EM1's columns
--     and checks dropped, last_polled_at and idx_monitored_mailboxes_enabled
--     back (last_polled_at now last in column order), enabled defaulting to
--     true, the draft's scope_label check, comment and authenticated_select
--     policy, and the grants it had (including Supabase's default anon and
--     authenticated grants, which RLS blocks: that is the pre-image, not a
--     recommendation);
-- and drops EM1's functions, the receipts table and the three inbox_events
-- sighting columns, and deletes the email_capture_v2 flag row it created
-- (while off). The
-- monitor-inbox pin to its hard-coded list is code and is reverted by PR, not
-- here; it is correct with or without this schema.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE x record; flag_on boolean:=false; sightings boolean:=false; receipts boolean:=false; foreign_rows boolean:=false;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_email_capture_status()','39f700ff23752f161c2215ecc500ece8'),
  ('public.context_email_capture_status_at(timestamptz)','78aefd4a54766e3e4967373e46fb934a'),
  ('public.context_email_capture_policy()','a7ebb664be0ffff255d7bc2481976054'),
  ('public.set_monitored_mailbox(text,boolean,text,text,text)','490a637f9ea0da6aae196e9ce1aeaf5d')) AS t(sig,md5) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(x.sig)) IS DISTINCT FROM x.md5
  THEN RAISE EXCEPTION 'em1_rollback_refused: % is not the EM1 body; roll back its owning slice first',x.sig; END IF;
 END LOOP;
 SELECT coalesce(bool_or(f.enabled),false) INTO flag_on FROM public.feature_flags f WHERE f.flag_name='email_capture_v2';
 IF flag_on THEN RAISE EXCEPTION 'em1_rollback_refused: flag email_capture_v2 is on; turn it off first'; END IF;
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.inbox_events WHERE business_event_id IS NOT NULL OR provider_message_id IS NOT NULL OR folder_kind IS NOT NULL)' INTO sightings;
 IF sightings THEN RAISE EXCEPTION 'em1_rollback_refused: inbox_events sighting columns hold values; roll back the email poller first'; END IF;
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.monitored_mailbox_changes)' INTO receipts;
 IF receipts THEN RAISE EXCEPTION 'em1_rollback_refused: monitored_mailbox_changes holds receipts; export them first'; END IF;
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.monitored_mailboxes WHERE updated_by<>''migration:20260924213000'')' INTO foreign_rows;
 IF foreign_rows THEN RAISE EXCEPTION 'em1_rollback_refused: monitored_mailboxes holds rows EM1 did not seed'; END IF;
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

-- The T7 draft table, empty, as it was.
DELETE FROM public.monitored_mailboxes WHERE updated_by='migration:20260924213000';
ALTER TABLE public.monitored_mailboxes
 DROP CONSTRAINT IF EXISTS monitored_mailboxes_scope_label_em1,
 DROP CONSTRAINT IF EXISTS monitored_mailboxes_email_format,
 DROP CONSTRAINT IF EXISTS monitored_mailboxes_source_key,
 DROP CONSTRAINT IF EXISTS monitored_mailboxes_source_key_unique,
 DROP CONSTRAINT IF EXISTS monitored_mailboxes_kind,
 DROP CONSTRAINT IF EXISTS monitored_mailboxes_enabled_active,
 DROP CONSTRAINT IF EXISTS monitored_mailboxes_unknown_pending,
 DROP CONSTRAINT IF EXISTS monitored_mailboxes_user_rules,
 DROP CONSTRAINT IF EXISTS monitored_mailboxes_updated_by;
ALTER TABLE public.monitored_mailboxes
 DROP COLUMN IF EXISTS source_key,
 DROP COLUMN IF EXISTS kind,
 DROP COLUMN IF EXISTS owner_privacy,
 DROP COLUMN IF EXISTS files_supplier_pdfs,
 DROP COLUMN IF EXISTS updated_by;
ALTER TABLE public.monitored_mailboxes ADD CONSTRAINT monitored_mailboxes_scope_label_check
 CHECK (scope_label IN ('owner','admin','finance','sales','patios','fencing','ops','other'));
ALTER TABLE public.monitored_mailboxes ALTER COLUMN enabled SET DEFAULT true;
ALTER TABLE public.monitored_mailboxes ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_monitored_mailboxes_enabled ON public.monitored_mailboxes(enabled,last_polled_at) WHERE enabled=true;
DROP POLICY IF EXISTS authenticated_select ON public.monitored_mailboxes;
CREATE POLICY authenticated_select ON public.monitored_mailboxes FOR SELECT TO authenticated USING (true);
GRANT ALL ON TABLE public.monitored_mailboxes TO anon,authenticated,service_role;
COMMENT ON TABLE public.monitored_mailboxes IS
 'T7 mailbox config. Replaces the hard-coded MONITORED_MAILBOXES constant in monitor-inbox/index.ts. No seed data - Marnin confirms list before population in Loop 8.';

DROP INDEX IF EXISTS public.inbox_events_business_event_id;
DROP INDEX IF EXISTS public.inbox_events_provider_message_id;
ALTER TABLE public.inbox_events DROP CONSTRAINT IF EXISTS inbox_events_business_event_id_fkey;
ALTER TABLE public.inbox_events DROP CONSTRAINT IF EXISTS inbox_events_folder_kind;
ALTER TABLE public.inbox_events DROP CONSTRAINT IF EXISTS inbox_events_provider_message_id;
ALTER TABLE public.inbox_events
 DROP COLUMN IF EXISTS business_event_id,
 DROP COLUMN IF EXISTS provider_message_id,
 DROP COLUMN IF EXISTS folder_kind;

-- Only the row this migration created (its description), and only while off.
DELETE FROM public.feature_flags WHERE flag_name='email_capture_v2' AND enabled=false
 AND description='Email capture v2 (email.md): the whole-mailbox Outlook poller reads monitored_mailboxes. Off: the old monitor-inbox path runs, pinned to its own list.';

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_email_capture_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 'em1_rollback: F1b stub not restored'; END IF;
END $$;
