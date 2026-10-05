-- Roll back B-2 (20261005190000_context_ghl_history_schedule).
--
-- Unschedules ghl-history-schedule, restores M4's context_ghl_history_due and
-- reserve_ghl_history_run bodies (20260925031500, md5 a52b2ffa5db7ca748e1d1069ec97da00
-- and dc0848e3b103f0e5c8a9a3947bebc154: every reserved job counted for the day,
-- a run row even when nothing is due) and the 20261002150000 body of
-- automation_switch_cron_lanes() (md5 5c1e0e526a74d5b4ad612792c7f076cc), drops
-- the schedule's functions, the link attempt record and
-- context_ghl_history_contacts.reads_requested_at. Nothing else is touched:
-- business_events rows, the M4 ledger rows, links and catch-up rows the
-- schedule wrote stay (they are ordinary records; the reader finishes the
-- catch-up rows under its caps). Run rows keep their cursors.
--
-- Refuses while the link attempt record holds a row: it is the only record of
-- which live jobs with no GHL contact the link step has tried (row 4's done
-- rule). Archive it with the owner's word before deleting its rows. Redeploy
-- the ghl-history-load edge function without the scheduled action after this
-- (until then the old reserve body answers it as before).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
 IF to_regclass('public.context_ghl_history_link_attempts') IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.context_ghl_history_link_attempts) THEN
  RAISE EXCEPTION 'ghl_history_schedule_rollback_refused: context_ghl_history_link_attempts holds rows; archive the link attempt record first';
 END IF;
 IF to_regclass('cron.job') IS NOT NULL AND to_regprocedure('cron.unschedule(bigint)') IS NOT NULL THEN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='ghl-history-schedule';
 END IF;
END $$;

-- M4's due list and reservation, verbatim.
CREATE OR REPLACE FUNCTION public.context_ghl_history_due(p_max_jobs integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 pol jsonb:=public.context_ghl_history_policy(); lim integer; day_start timestamptz; counted integer; remaining integer;
 picked jsonb:='[]'::jsonb; used integer:=0; waiting_contacts integer:=0; waiting_jobs integer:=0; over_contacts integer:=0; over_jobs integer:=0;
 r record; bad_ids integer;
BEGIN
 IF p_max_jobs IS NULL OR p_max_jobs<1 THEN RAISE EXCEPTION 'history_due_max_jobs_invalid'; END IF;
 lim:=(pol->>'daily_job_limit')::integer;
 day_start:=(date_trunc('day',now() AT TIME ZONE (pol->>'day_zone'))) AT TIME ZONE (pol->>'day_zone');
 SELECT coalesce(sum(CASE WHEN jsonb_typeof(c.counts->'jobs_covered')='number' THEN (c.counts->>'jobs_covered')::integer ELSE 0 END),0)::integer
 INTO counted FROM public.context_capture_runs c WHERE c.source=pol->>'run_source' AND c.started_at>=day_start;
 remaining:=greatest(0,lim-counted);
 -- A contact id that is not a GHL id cannot be read from GHL: counted, never offered.
 SELECT count(*)::integer INTO bad_ids FROM public.context_ghl_history_live_jobs() l
 WHERE l.ghl_contact_id IS NOT NULL AND l.ghl_contact_id !~ '^[A-Za-z0-9_-]{6,64}$';
 FOR r IN
  WITH live AS (SELECT * FROM public.context_ghl_history_live_jobs() l WHERE l.ghl_contact_id ~ '^[A-Za-z0-9_-]{6,64}$'),
  by_contact AS (
   SELECT l.ghl_contact_id AS contact_id, array_agg(l.job_id ORDER BY l.job_id) AS job_ids, count(*)::integer AS jobs,
    min(l.tier) AS tier, max(l.activity_at) AS activity_at
   FROM live l GROUP BY l.ghl_contact_id
  )
  SELECT b.*, h.status AS prior_status, h.resume, coalesce(h.attempts,0) AS attempts
  FROM by_contact b LEFT JOIN public.context_ghl_history_contacts h ON h.contact_id=b.contact_id
  -- Never loaded, part loaded, or failed on an earlier day (retried, never given up on).
  WHERE h.contact_id IS NULL OR h.status='partial' OR (h.status='failed' AND h.last_attempt_at<day_start)
  ORDER BY (h.status='partial') DESC NULLS LAST, b.tier, b.activity_at DESC NULLS LAST, b.contact_id
 LOOP
  IF r.jobs>lim THEN
   -- More live jobs than a whole day allows: never inside the bound, so never offered.
   over_contacts:=over_contacts+1; over_jobs:=over_jobs+r.jobs;
  ELSIF used<p_max_jobs AND used+r.jobs<=remaining THEN
   picked:=picked||jsonb_build_array(jsonb_build_object('contact_id',r.contact_id,'job_ids',to_jsonb(r.job_ids),'jobs',r.jobs,
    'prior_status',r.prior_status,'resume',r.resume,'attempts',r.attempts));
   used:=used+r.jobs;
  ELSE
   waiting_contacts:=waiting_contacts+1; waiting_jobs:=waiting_jobs+r.jobs;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('daily_job_limit',lim,'jobs_counted_today',counted,'daily_remaining',remaining,'max_jobs',p_max_jobs,
  'day_start',day_start,'contacts',picked,'jobs_offered',used,'contacts_waiting',waiting_contacts,'jobs_waiting',waiting_jobs,
  'contacts_over_daily_limit',over_contacts,'jobs_over_daily_limit',over_jobs,
  'daily_limit_reached',remaining=0,'jobs_invalid_contact_id',bad_ids);
END $$;
COMMENT ON FUNCTION public.context_ghl_history_due(integer) IS
 'M4: the next GHL contacts to load, from the live jobs grouped by contact: partial loads first, then in progress, booked, accepted, quotes, newest activity first. The jobs offered never exceed 100 minus the jobs counted by today''s ghl_history_load runs (Perth day); contacts are added while fewer than p_max_jobs are offered and the whole contact fits. A contact with more live jobs than a whole day is never offered (counted). Done contacts are not offered; failed ones are offered again on a later day. Read only.';

CREATE OR REPLACE FUNCTION public.reserve_ghl_history_run(p_max_jobs integer, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy(); v_actor text:=coalesce(nullif(p_actor,''),'actor_missing');
 live_run record; due jsonb; created jsonb;
BEGIN
 IF v_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'history_reserve_actor_invalid'; END IF;
 -- One reservation at a time: a second caller waits here, then sees the first
 -- run's counted jobs.
 PERFORM pg_advisory_xact_lock(hashtextextended('context_ghl_history_load',0));
 SELECT c.id, c.updated_at INTO live_run FROM public.context_capture_runs c
 WHERE c.source=pol->>'run_source' AND c.status='running' ORDER BY c.started_at DESC LIMIT 1;
 IF FOUND THEN
  IF live_run.updated_at>clock_timestamp()-make_interval(mins=>(pol->>'running_stale_minutes')::integer) THEN
   RETURN jsonb_build_object('outcome','run_in_progress','run_id',live_run.id);
  END IF;
  -- The worker died mid-run. Its counted jobs stay counted.
  PERFORM public.record_capture_run(jsonb_build_object('run_id',live_run.id,'source',pol->>'run_source','status','failed','error_code','run_abandoned'));
 END IF;
 due:=public.context_ghl_history_due(p_max_jobs);
 created:=public.record_capture_run(jsonb_build_object('source',pol->>'run_source','status','running','window_to',clock_timestamp(),
  'cursor',jsonb_build_object('v',1,'actor',v_actor),
  'counts',jsonb_build_object('dry_run',0,'jobs_covered',(due->>'jobs_offered')::integer,'daily_job_limit',(due->>'daily_job_limit')::integer,
   'jobs_counted_before',(due->>'jobs_counted_today')::integer,'daily_remaining',(due->>'daily_remaining')::integer,
   'contacts_due',jsonb_array_length(due->'contacts'))));
 RETURN jsonb_build_object('outcome','reserved','run_id',created->>'run_id','due',due);
END $$;
COMMENT ON FUNCTION public.reserve_ghl_history_run(integer,text) IS
 'M4: starts a real history-load run atomically. Under one transaction-scoped advisory lock: refuses while another real run is live (run_in_progress), closes an abandoned one (run_abandoned), selects the due contacts and creates the run row with their jobs already counted in jobs_covered, so simultaneous callers never share the remaining daily quota. Returns {outcome: reserved, run_id, due} or {outcome: run_in_progress, run_id}.';

-- The 20261002150000 lane list, verbatim.
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
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;

DROP FUNCTION IF EXISTS public.trigger_ghl_history_schedule();
DROP FUNCTION IF EXISTS public.context_ghl_history_progress();
DROP FUNCTION IF EXISTS public.context_ghl_history_request_reads(boolean,integer);
DROP FUNCTION IF EXISTS public.context_ghl_history_link_due(integer);
DROP FUNCTION IF EXISTS public.record_ghl_link_attempt(jsonb);
DROP FUNCTION IF EXISTS public.context_ghl_history_due_at(integer,jsonb);
DROP FUNCTION IF EXISTS public.context_ghl_history_day_limit(boolean);
DROP FUNCTION IF EXISTS public.context_ghl_history_schedule_policy();
DROP TABLE IF EXISTS public.context_ghl_history_link_attempts;
ALTER TABLE public.context_ghl_history_contacts DROP COLUMN IF EXISTS reads_requested_at;

REVOKE ALL ON FUNCTION public.context_ghl_history_due(integer),public.reserve_ghl_history_run(integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_ghl_history_due(integer),public.reserve_ghl_history_run(integer,text) TO service_role;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_ghl_history_due(integer)')) IS DISTINCT FROM 'a52b2ffa5db7ca748e1d1069ec97da00'
 THEN RAISE EXCEPTION 'ghl_history_schedule_rollback_check_failed: context_ghl_history_due(integer) differs from the M4 body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.reserve_ghl_history_run(integer,text)')) IS DISTINCT FROM 'dc0848e3b103f0e5c8a9a3947bebc154'
 THEN RAISE EXCEPTION 'ghl_history_schedule_rollback_check_failed: reserve_ghl_history_run(integer,text) differs from the M4 body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM '5c1e0e526a74d5b4ad612792c7f076cc'
 THEN RAISE EXCEPTION 'ghl_history_schedule_rollback_check_failed: automation_switch_cron_lanes() differs from the 20261002150000 body'; END IF;
END $$;
