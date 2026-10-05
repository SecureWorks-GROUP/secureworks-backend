-- Roll back B-5 (20261005210000_context_document_text).
--
-- Turn feature flag context_document_text_v1 off first: this refuses while it
-- is on. Then it unschedules the context-document-text cron job, restores the
-- GHL history schedule body of automation_switch_cron_lanes() (20261005190000), and
-- drops the functions B-5 added and context_document_texts (the read records:
-- outcomes and counts only, no words). The restored lane list is checked by
-- md5 afterwards: 8c99245789cadf661d4b6be1207f0887.
-- No evidence is touched: document.text_extracted rows the reader saved stay
-- in business_events, and so do their context_capture_runs rows. Refuses if a
-- later slice has already replaced the lane list (roll that slice back
-- first). The edge function needs no redeploy: without the cron job nothing
-- calls it, and it idles while the flag is off.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
 IF coalesce((public.context_document_text_flag()->>'enabled')::boolean,false) THEN
  RAISE EXCEPTION 'b5_rollback_refused: feature flag context_document_text_v1 is on; turn it off first';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) NOT IN ('99e6d70e80a79e548f2478b65fc6cd78','8c99245789cadf661d4b6be1207f0887')
 THEN RAISE EXCEPTION 'b5_rollback_refused: automation_switch_cron_lanes is no longer the B-5 body; roll back its later owner first'; END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='context-document-text';
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
    ('outlook-mail-poll', 'capture'),
    ('monitor-inbox-sweep', 'capture'),
    ('ghl-history-schedule', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;

DROP FUNCTION IF EXISTS public.trigger_context_document_text();
DROP FUNCTION IF EXISTS public.context_document_text_status();
DROP FUNCTION IF EXISTS public.context_document_text_due(integer);
DROP FUNCTION IF EXISTS public.context_document_text_sources();
DROP FUNCTION IF EXISTS public.record_context_document_text(jsonb);
DROP TABLE IF EXISTS public.context_document_texts;
DROP FUNCTION IF EXISTS public.context_document_text_flag();
DROP FUNCTION IF EXISTS public.context_document_text_policy();

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()'))<>'8c99245789cadf661d4b6be1207f0887'
 THEN RAISE EXCEPTION 'b5_rollback: automation_switch_cron_lanes not restored byte for byte'; END IF;
END $$;
