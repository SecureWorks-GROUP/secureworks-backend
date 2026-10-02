-- Roll back EM2/EM3 (20261002150000_context_email_reader).
--
-- Refuses while email_reader_v1 or email_reader_schedule_v1 is on (turn them
-- off first), and while the attachment ledger holds a row (its files are in
-- the private bucket; move or delete them deliberately first). Then:
-- unschedules outlook-mail-poll and monitor-inbox-sweep, restores the T2
-- automation_switch_cron_lanes() body (20261002100000, md5
-- 4f80b88d5c5ef6a49a6677f1a76d6350: C1d's rows plus ghl-call-transcript-fetch),
-- drops the reader's functions and the ledger table, deletes the two flag
-- rows, and removes the empty private bucket. Evidence rows the reader saved
-- in business_events stay (they are ordinary evidence; the ladder placed
-- them). The old monitor-inbox path resumes its own evidence rows on its own
-- once the flags are gone (reader_handover.ts reads missing as not handed
-- over).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
 IF to_regclass('public.feature_flags') IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1') AND enabled)
 THEN RAISE EXCEPTION 'email_reader_rollback_refused: email_reader_v1 or email_reader_schedule_v1 is on; turn both off first'; END IF;
 IF to_regclass('public.context_email_attachments') IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.context_email_attachments)
 THEN RAISE EXCEPTION 'email_reader_rollback_refused: context_email_attachments holds rows; their files are in the private bucket'; END IF;
 IF to_regclass('cron.job') IS NOT NULL AND to_regprocedure('cron.unschedule(bigint)') IS NOT NULL THEN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('outlook-mail-poll','monitor-inbox-sweep');
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    ('ghl-message-reconcile', 'capture'),
    ('ghl-call-transcript-fetch', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;

DROP FUNCTION IF EXISTS public.trigger_context_email_sweep();
DROP FUNCTION IF EXISTS public.trigger_context_email_poll();
DROP FUNCTION IF EXISTS public.context_email_history_scope();
DROP FUNCTION IF EXISTS public.context_email_job_client_emails();
DROP FUNCTION IF EXISTS public.context_email_supplier_domains();
DROP FUNCTION IF EXISTS public.context_email_reader_flags();
DROP TABLE IF EXISTS public.context_email_attachments;
DELETE FROM public.feature_flags WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1');

DO $$
BEGIN
 IF to_regclass('storage.buckets') IS NOT NULL THEN
  IF to_regclass('storage.objects') IS NOT NULL
   AND EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='context-email-attachments')
  THEN RAISE EXCEPTION 'email_reader_rollback_refused: bucket context-email-attachments still holds files'; END IF;
  DELETE FROM storage.buckets WHERE id='context-email-attachments';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM '4f80b88d5c5ef6a49a6677f1a76d6350'
 THEN RAISE EXCEPTION 'email_reader_rollback_check_failed: automation_switch_cron_lanes() differs from the T2 body'; END IF;
END $$;
