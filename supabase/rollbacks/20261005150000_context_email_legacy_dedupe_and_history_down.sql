-- Roll back gap plan B-1 (20261005150000_context_email_legacy_dedupe_and_history).
--
-- Refuses while email_reader_history_v1 is on (turn it off first). Then
-- restores EM3's trigger_context_email_poll() byte for byte (20261002150000,
-- md5 7681b900e3be69c8df1d935f85fbde0a), drops the history tick, the plan
-- table, the status read, the re-list writer and the old-path lookup, and
-- deletes the flag row. Evidence rows and catch-up list rows written while it
-- ran stay (ordinary evidence; the list drains through the normal worker).
-- Deploy the previous outlook-mail-capture first: the reader calls
-- context_email_legacy_copy before every inbound save, and a missing function
-- fails its runs (legacy_copy_unreadable) rather than saving duplicates.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
 IF to_regclass('public.feature_flags') IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_history_v1' AND enabled)
 THEN RAISE EXCEPTION 'email_history_rollback_refused: email_reader_history_v1 is on; turn it off first'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.trigger_context_email_poll() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb:=public.context_email_reader_flags();
BEGIN
 IF NOT ((f->>'reader')::boolean AND (f->>'schedule')::boolean AND (f->>'program')::boolean) THEN RETURN; END IF;
 PERFORM net.http_post(
  url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture',
  body := jsonb_build_object('mode','poll','actor','cron:outlook-mail-poll'),
  headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
  timeout_milliseconds := 5000
 );
END $$;
COMMENT ON FUNCTION public.trigger_context_email_poll() IS
 'pg_cron outlook-mail-poll (every 5 minutes, capture lane): posts {mode: poll} to the outlook-mail-capture edge function with the service key while email_reader_v1, email_reader_schedule_v1 and email_capture_v2 are on. EM3.';
REVOKE ALL ON FUNCTION public.trigger_context_email_poll() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_context_email_poll() TO postgres;

DROP FUNCTION IF EXISTS public.trigger_context_email_history();
DROP FUNCTION IF EXISTS public.context_email_history_status();
DROP FUNCTION IF EXISTS public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer);
DROP FUNCTION IF EXISTS public.context_email_legacy_copy(text,timestamptz,text);
DROP TABLE IF EXISTS public.context_email_history_plan;
DELETE FROM public.feature_flags WHERE flag_name='email_reader_history_v1';

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.trigger_context_email_poll()')) IS DISTINCT FROM '7681b900e3be69c8df1d935f85fbde0a'
 THEN RAISE EXCEPTION 'email_history_rollback_check_failed: trigger_context_email_poll() differs from the EM3 body'; END IF;
END $$;
