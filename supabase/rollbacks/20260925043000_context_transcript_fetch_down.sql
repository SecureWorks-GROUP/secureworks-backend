-- Roll back T2 (20260925043000_context_transcript_fetch).
--
-- Turn feature flag ghl_call_transcript_fetch_v1 off first: this refuses while
-- it is on. Then it unschedules the ghl-call-transcript-fetch cron job,
-- restores the F1b stub of context_transcript_capture_status() (with its
-- comment and grants) and the three-row automation_switch_cron_lanes() of C1d,
-- and drops the functions T2 added and call_transcript_fetches (the fetch
-- records: attempts and outcomes only, no words). Byte-for-byte restores are
-- checked by md5 afterwards:
--   context_transcript_capture_status()  155104bfb08b8b3c2f98bdec089d4ee4
--   automation_switch_cron_lanes()       459035de5d3f7f7af49c36f09d9be29e
-- No evidence is touched: call.transcript_completed rows the fetcher saved and
-- call rows the history load wrote stay in business_events, and so do their
-- context_capture_runs rows. Refuses if a later slice has already replaced the
-- transcript_capture block or the lane list (roll that slice back first). The
-- edge function needs no redeploy: without the cron job nothing calls it, and
-- it idles while the flag is off.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
 IF coalesce((public.context_transcript_fetch_flag()->>'enabled')::boolean,false) THEN
  RAISE EXCEPTION 't2_rollback_refused: feature flag ghl_call_transcript_fetch_v1 is on; turn it off first';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_transcript_capture_status()')) NOT IN ('fce1a8f610ddf41a26cb097e9bae1171','155104bfb08b8b3c2f98bdec089d4ee4')
 THEN RAISE EXCEPTION 't2_rollback_refused: context_transcript_capture_status is no longer the T2 body; roll back its later owner first'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) NOT IN ('4f80b88d5c5ef6a49a6677f1a76d6350','459035de5d3f7f7af49c36f09d9be29e')
 THEN RAISE EXCEPTION 't2_rollback_refused: automation_switch_cron_lanes is no longer the T2 body; roll back its later owner first'; END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='ghl-call-transcript-fetch';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.context_transcript_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_transcript_capture_status() IS
 'F1b stub. Status block transcript_capture, owned by transcripts slice T2, which replaces this body. Null means not built yet.';
REVOKE ALL ON FUNCTION public.context_transcript_capture_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_transcript_capture_status() TO service_role;

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
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;

DROP FUNCTION IF EXISTS public.trigger_ghl_call_transcript_fetch();
DROP FUNCTION IF EXISTS public.context_transcript_due_calls(integer,boolean);
DROP FUNCTION IF EXISTS public.context_call_transcript_eligible(text,text,jsonb);
DROP FUNCTION IF EXISTS public.record_call_transcript_fetch(jsonb);
DROP TABLE IF EXISTS public.call_transcript_fetches;
DROP FUNCTION IF EXISTS public.context_transcript_fetch_flag();
DROP FUNCTION IF EXISTS public.context_transcript_capture_policy();

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_transcript_capture_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM '459035de5d3f7f7af49c36f09d9be29e'
 THEN RAISE EXCEPTION 't2_rollback_check_failed: restored bodies differ from the production pre-image'; END IF;
END $$;
