-- Follow-up 32 (before the story's stored-profit switch): the story's stored
-- Job Profit snapshot also needs no newer change mark on the job.
-- Replaces one private body, job_story_stored_profit_as_at (20261118115531),
-- md5-guarded. Everything else it checks is kept word for word. Added: the
-- job's newest change mark (job_change_mark_events and job_change_marks_base,
-- written by job_mark_changed) must be no later than the start of the refresh
-- transaction that stored the snapshot (refresh_started_at, which is earlier
-- than computed_at). Otherwise the answer is NULL and the switch wrapper
-- serves the live book, exactly as main does. Left out: the store's own marks
-- ('profit', written by job_profit_refresh_many just after its stamp, and the
-- bulk source 'bulk'); a mark folded nightly keeps no source and always counts.
-- On merge: one replaced private body. No entry point, trigger, schedule,
-- table, index or switch changes. job_story_stored_profit_v1 stays as it is.
-- job_profit_stored_read_v1 has no reader on main; none is added here.
-- Rollback: supabase/rollbacks/20261118153102_job_story_stored_profit_change_marks_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Rule 15: the body replaced is the FU26.1 follow-up's (20261118115531) or
-- this migration's own (a re-apply). Anything else refuses.
DO $guard$
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.job_story_stored_profit_as_at(uuid,timestamptz)'))
    NOT IN ('48d8c171c00cb3015688a27abffd4800','ea1bd9b50d9191e704653525370d74e3') THEN
  RAISE EXCEPTION 'story_stored_profit_change_marks_preimage: job_story_stored_profit_as_at'; END IF;
 IF to_regclass('public.job_change_mark_events') IS NULL OR to_regclass('public.job_change_marks_base') IS NULL THEN
  RAISE EXCEPTION 'story_stored_profit_change_marks_needs_mark_tables'; END IF;
END $guard$;

-- The as-at time of a stored snapshot the story may use for this job, or NULL.
-- Usable only while the store is armed, the profit refresh is on, every one of
-- its source triggers is installed and enabled (the same ones as when armed),
-- nothing for the job is queued or marked dirty, no change mark for the job
-- is newer than the start of the refresh that stored it, the summary was
-- computed by a refresh transaction begun after the arm stamp, on the as-of
-- Perth day, and its two event sets are exactly the ones its refresh
-- fingerprinted (every field of every row), none stamped later or on another
-- day. The fingerprint settings are the counts trigger's own.
CREATE OR REPLACE FUNCTION public.job_story_stored_profit_as_at(p_job_id uuid,p_as_of timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
 SET TimeZone='UTC' SET DateStyle='ISO, MDY' SET IntervalStyle='postgres' SET extra_float_digits='1' AS $fn$
DECLARE stamp timestamptz; v_armed_at timestamptz; v_setup text;
/* function block */ BEGIN
 -- job_story_stored_profit_arm_pkey (one row).
 SELECT a.armed_at,a.setup INTO v_armed_at,v_setup FROM public.job_story_stored_profit_arm a WHERE a.singleton;
 IF p_job_id IS NULL OR v_armed_at IS NULL OR v_setup IS NULL
 -- feature_flags key.
 OR NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled)
 -- Every source trigger present and O/A, and the same triggers as when armed.
 OR public.job_story_stored_profit_setup() IS DISTINCT FROM v_setup THEN
  RETURN NULL;
 END IF;
 -- job_profit_stored_pkey, job_story_stored_profit_counts_pkey,
 -- job_profit_dirty_pkey, job_profit_change_events_job_idx,
 -- job_cost_events_stored_job_idx and job_revenue_events_stored_job_idx.
 -- The sole writer (job_profit_refresh_many) replaces all three sets in one
 -- transaction, stamping each row with clock_timestamp(): events before summary.
 SELECT s.computed_at INTO stamp FROM public.job_profit_stored s
 JOIN public.job_story_stored_profit_counts k ON k.job_id=s.job_id AND k.computed_at=s.computed_at
 CROSS JOIN LATERAL (SELECT count(*) n,md5(coalesce(string_agg(c::text,'|' ORDER BY c::text COLLATE "C"),'')) f,
   bool_or(c.computed_at>s.computed_at OR (c.computed_at AT TIME ZONE 'Australia/Perth')::date<>(s.computed_at AT TIME ZONE 'Australia/Perth')::date) late
  FROM public.job_cost_events_stored c WHERE c.job_id=p_job_id) ce
 CROSS JOIN LATERAL (SELECT count(*) n,md5(coalesce(string_agg(e::text,'|' ORDER BY e::text COLLATE "C"),'')) f,
   bool_or(e.computed_at>s.computed_at OR (e.computed_at AT TIME ZONE 'Australia/Perth')::date<>(s.computed_at AT TIME ZONE 'Australia/Perth')::date) late
  FROM public.job_revenue_events_stored e WHERE e.job_id=p_job_id) re
 WHERE s.job_id=p_job_id
  AND s.computed_at>v_armed_at
  AND k.refresh_started_at>v_armed_at
  AND s.computed_at<=p_as_of
  AND (s.computed_at AT TIME ZONE 'Australia/Perth')::date=(p_as_of AT TIME ZONE 'Australia/Perth')::date
  AND NOT EXISTS(SELECT 1 FROM public.job_profit_dirty d WHERE d.job_id=p_job_id)
  AND NOT EXISTS(SELECT 1 FROM public.job_profit_change_events q WHERE q.job_id=p_job_id)
  -- The job's newest change mark (P0-02, the job page marks) is no later
  -- than the start of the refresh that stored this snapshot. The store's own
  -- marks ('profit', and the bulk source 'bulk') are written after its stamp
  -- and are left out; a folded mark keeps no source and always counts.
  -- job_change_mark_events_job (job_id) and job_change_marks_pkey (job_id).
  AND NOT EXISTS(SELECT 1 FROM public.job_change_mark_events m WHERE m.job_id=p_job_id
   AND m.source NOT IN ('profit','bulk') AND m.marked_at>k.refresh_started_at)
  AND NOT EXISTS(SELECT 1 FROM public.job_change_marks_base b WHERE b.job_id=p_job_id
   AND b.last_marked_at>k.refresh_started_at)
  -- Exactly the events this refresh stored: none missing, none added, no
  -- field of any row changed, none stamped later or on another day.
  AND ce.n=k.cost_events AND ce.f=k.cost_print AND NOT coalesce(ce.late,false)
  AND re.n=k.revenue_events AND re.f=k.revenue_print AND NOT coalesce(re.late,false);
 RETURN stamp;
END $fn$;

REVOKE ALL ON FUNCTION public.job_story_stored_profit_as_at(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_story_stored_profit_as_at(uuid,timestamptz) TO service_role;
