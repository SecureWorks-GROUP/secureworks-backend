-- Roll back the paid close-out (20261013150000_job_closeout_review_archive).
--
-- Refuses while any close-out switch is on (turn them off first: the move, the sender
-- and the closeout lane), and while automation_switch_cron_lanes() names
-- job-closeout-sweep in a body that is not this migration's (a later slice built on it:
-- roll that one back first). Then: unschedules job-closeout-sweep, gives the lane list
-- back as the email deep history slice wrote it (md5 6498276b1eb16b527fb76dd2b0fa6d83),
-- takes closeout out of automation_lane_enabled() and drops the column, the sweep caller
-- and the three tables.
--
-- The review claims go with their table. Deploy the previous ops-api and xero-sync
-- first: the new code reads job_closeout_settings, and an unreadable row reads as every
-- switch off, so the old Xero rule then runs anyway.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE live text;
BEGIN
 IF to_regclass('public.job_closeout_settings') IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.job_closeout_settings WHERE get_review_move_enabled OR review_sender_mode <> 'off')
 THEN RAISE EXCEPTION 'job_closeout_rollback_refused: a close-out switch is on; turn it off first'; END IF;
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'automation_switches' AND column_name = 'closeout')
  AND EXISTS (SELECT 1 FROM public.automation_switches WHERE id = 1 AND closeout)
 THEN RAISE EXCEPTION 'job_closeout_rollback_refused: the closeout lane is on; turn it off first'; END IF;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.automation_switch_cron_lanes()');
 IF live IS NULL THEN RAISE EXCEPTION 'job_closeout_rollback_refused: automation_switch_cron_lanes() is missing'; END IF;
 IF live <> 'd0a346b823b56258bf67bc835f41f922'
  AND EXISTS (SELECT 1 FROM public.automation_switch_cron_lanes() l WHERE l.cron_jobname = 'job-closeout-sweep') THEN
  RAISE EXCEPTION 'job_closeout_rollback_refused: automation_switch_cron_lanes() md5 % names job-closeout-sweep and is a later slice''s body; roll that slice back first', live;
 END IF;
 IF to_regclass('cron.job') IS NOT NULL AND to_regprocedure('cron.unschedule(bigint)') IS NOT NULL THEN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'job-closeout-sweep';
 END IF;
END $$;

-- The lane list without this migration's row, verbatim (20261007080000's body).
DO $lanes$
BEGIN
 IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.automation_switch_cron_lanes()'::regprocedure) <> 'd0a346b823b56258bf67bc835f41f922' THEN
  RAISE NOTICE 'job closeout rollback: lane list is not this migration''s; left alone';
  RETURN;
 END IF;
 EXECUTE $def$
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
    ('xero-history-daily', 'capture'),
    ('outlook-mail-deep-history', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$
$def$;
 IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.automation_switch_cron_lanes()'::regprocedure) <> '6498276b1eb16b527fb76dd2b0fa6d83' THEN
  RAISE EXCEPTION 'job_closeout_rollback_failed: lane list is not md5 6498276b1eb16b527fb76dd2b0fa6d83';
 END IF;
END $lanes$;

-- The reader as 20260911170000 wrote it: capture, attribution, extraction.
CREATE OR REPLACE FUNCTION public.automation_lane_enabled(lane text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_all_stop boolean;
  v_lane     boolean;
BEGIN
  IF lane IS NULL THEN
    RETURN false;
  END IF;
  IF lane NOT IN ('capture', 'attribution', 'extraction') THEN
    RETURN false;
  END IF;
  IF to_regclass('public.automation_switches') IS NULL THEN
    RETURN false;
  END IF;

  EXECUTE format(
    'SELECT s.all_stop, s.%I FROM public.automation_switches s WHERE s.id = 1',
    lane
  ) INTO v_all_stop, v_lane;

  -- No row at all: both come back null, which is off.
  IF v_all_stop IS NULL OR v_lane IS NULL THEN
    RETURN false;
  END IF;
  IF v_all_stop THEN
    RETURN false;
  END IF;
  RETURN v_lane;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

COMMENT ON FUNCTION public.automation_lane_enabled(text) IS
  'True only when public.automation_switches row 1 exists, all_stop is false and the named lane column is true. False for an unknown lane, a missing row, a missing table and any error. Spec section 6.';

ALTER TABLE public.automation_switches DROP COLUMN IF EXISTS closeout;
DROP FUNCTION IF EXISTS public.trigger_job_closeout_sweep();
DROP TABLE IF EXISTS public.job_review_claims;
DROP TABLE IF EXISTS public.job_closeout_state;
DROP TABLE IF EXISTS public.job_closeout_settings;
