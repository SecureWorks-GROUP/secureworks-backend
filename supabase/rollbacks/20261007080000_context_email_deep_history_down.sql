-- Roll back history depth PR B (20261007080000_context_email_deep_history).
--
-- Refuses while email_reader_deep_v1 is on (turn it off first), and while
-- automation_switch_cron_lanes() is neither this migration's body nor B-5's
-- (a later slice changed it: roll that one back first). Then: unschedules
-- outlook-mail-deep-history, restores B-5's automation_switch_cron_lanes()
-- body (20261005210000, md5 99e6d70e80a79e548f2478b65fc6cd78) byte for byte,
-- drops the deep load's functions and its three tables (plan, reach, members),
-- and deletes the flag row.
--
-- Deep rows already captured stay: they are ordinary evidence the ladder
-- placed, and the job ledger may already have read and cited them. Retracting
-- them, if ever wanted, is a separate guarded script with an undo. The reader
-- (outlook-mail-capture) refuses mode deep once context_email_deep_enabled is
-- gone (deep_gate_unreadable), so redeploying the previous reader can follow
-- at leisure. Scorecard v2 reads context_email_history_reach and
-- context_email_history_reach_jobs: roll it back first, or its row 14 email
-- lanes stop answering.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE live text;
BEGIN
 IF to_regclass('public.feature_flags') IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_deep_v1' AND enabled)
 THEN RAISE EXCEPTION 'email_deep_history_rollback_refused: email_reader_deep_v1 is on; turn it off first'; END IF;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.automation_switch_cron_lanes()');
 IF live IS NULL OR live NOT IN ('250d7e9ec2ebecc7e83192a39b7da488','99e6d70e80a79e548f2478b65fc6cd78') THEN
  RAISE EXCEPTION 'email_deep_history_rollback_refused: automation_switch_cron_lanes() md5 % is a later slice''s body; roll that slice back first',coalesce(live,'<missing>');
 END IF;
 IF to_regclass('cron.job') IS NOT NULL AND to_regprocedure('cron.unschedule(bigint)') IS NOT NULL THEN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='outlook-mail-deep-history';
 END IF;
END $$;

-- B-5's lane list (20261005210000), verbatim.
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
    ('context-document-text', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;

DROP FUNCTION IF EXISTS public.context_email_history_reach(timestamptz);
DROP FUNCTION IF EXISTS public.context_email_history_reach_jobs(uuid[],timestamptz);
DROP FUNCTION IF EXISTS public.context_email_deep_status();
DROP FUNCTION IF EXISTS public.trigger_context_email_deep_history();
DROP FUNCTION IF EXISTS public.context_email_deep_scope();
DROP FUNCTION IF EXISTS public.context_email_deep_scope_jobs(timestamptz);
DROP FUNCTION IF EXISTS public.context_email_deep_live_floor(text);
DROP FUNCTION IF EXISTS public.context_email_deep_job_refs(jsonb);
DROP FUNCTION IF EXISTS public.context_email_deep_enabled();
DROP FUNCTION IF EXISTS public.context_email_deep_policy();
DROP TABLE IF EXISTS public.context_email_deep_reach;
DROP TABLE IF EXISTS public.context_email_deep_plan;
DROP TABLE IF EXISTS public.context_email_deep_members;
DELETE FROM public.feature_flags WHERE flag_name='email_reader_deep_v1';

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM '99e6d70e80a79e548f2478b65fc6cd78'
 THEN RAISE EXCEPTION 'email_deep_history_rollback_check_failed: automation_switch_cron_lanes() differs from the B-5 body'; END IF;
END $$;
