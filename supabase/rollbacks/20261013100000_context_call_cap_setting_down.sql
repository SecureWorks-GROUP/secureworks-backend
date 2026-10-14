-- Rollback for 20261013100000_context_call_cap_setting.sql: the seven readers of the call caps go back to their
-- bodies as they were before it, word for word (production, 13 Oct 2026), so they read
-- model_call_cap and morning_cap from context_cadence_policy() again; the wrapper
-- context_cadence_policy_today() and the column context_ledger_settings.read_concurrency are
-- dropped; the two CHECKs go back to 1,000 and the settings table's comment to its earlier words.
-- No row is written. Where a row already passes 1,000 (a reservation of a raised day, or
-- calls_per_day still above 1,000) its CHECK comes back NOT VALID: the row stays, new rows are
-- held to 1,000, and with the wrapper gone a calls_per_day above 1,000 is only the ledger's own
-- ceiling above the day's cap, which the cap still bounds. Refuses unless each body is this
-- migration's or already the earlier one (a re-run is a no-op): a later change must be rolled
-- back first. Signatures, owners and grants never changed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE problems text[] := '{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', ARRAY['25a5b5f208af726d47e952f98cecef56','e381963e14d214b6b43c98eb70836919']),
  ('public.context_ledger_budget()', ARRAY['8f7b42529db2e1062283de005cef01a7','e1342d1e088674c8e47ae4d2af317c6e']),
  ('public.context_jobs_cadence(uuid[])', ARRAY['c711479690d167f09d016f0413f11160','9750d24f7d8d79e05018c2b2f9e3781c']),
  ('public.context_document_vision_admission()', ARRAY['f1d33b0f0ee54516941ee313cb7fe756','6fc6fbe5e932885a6105d462932ee5bb']),
  ('public.context_job_story_budget()', ARRAY['bd32ab0faece36527b05abdce0474f47','7a54f0abc1b11389181ccc6664dd0e34']),
  ('public.context_cadence_status()', ARRAY['85e60d754e65b812b28e798435e2a5a4','ddcd452a67e9e15150ac05d7847e655f']),
  ('public.context_core_status()', ARRAY['2b6b2c54daeae381cdeff7802d72df81','07c51159715c91663a1038f01bf6e09c'])
 ) AS t(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_call_cap_setting_down_refused: %; a later change replaced these, roll it back first',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- The seven bodies as they were before 20261013100000_context_call_cap_setting, word for word.

-- 1 of 7. reserve_context_model_call: policy calls back on context_cadence_policy(): 1.
CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text, p_run_id uuid, p_lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_now timestamptz; v_date date; v_ordinal integer; v_id uuid; r public.context_extraction_runs;
 v_ledger_mode text; v_ledger_calls integer; v_pol jsonb; v_calls integer; v_reserve_day integer; v_reserve_morning integer;
 v_story_calls integer;
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket','vision','ledger','story')
 OR (p_run_id IS NULL) <> (p_lease_token IS NULL)
 OR (p_phase IN ('extraction','ledger') AND p_run_id IS NULL)
 OR (p_phase IN ('vision','story') AND p_run_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid model call identity';
 END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision','ledger','story') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM 1 FROM public.automation_switches WHERE id=1 FOR SHARE;
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision','ledger','story') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 IF p_run_id IS NOT NULL THEN
  SELECT * INTO r FROM public.context_extraction_runs WHERE id=p_run_id FOR UPDATE;
 END IF;
 v_now := clock_timestamp();
 v_date := (v_now AT TIME ZONE 'Australia/Perth')::date;
 IF p_run_id IS NOT NULL AND (r.id IS NULL OR r.lease_token IS DISTINCT FROM p_lease_token
 OR r.phase IS DISTINCT FROM p_phase OR r.status <> 'running'
 OR r.lease_expires_at IS NULL OR r.lease_expires_at <= v_now OR r.run_date <> v_date)
 THEN RETURN jsonb_build_object('outcome','stale'); END IF;
 -- call budget (20261006060000): the day's cap and attribution's share are the
 -- policy's numbers (owner ruling 6 Oct 2026: 1,000 calls, 300 for placement).
 v_pol := public.context_cadence_policy();
 SELECT coalesce(max(ordinal),0)+1 INTO v_ordinal FROM public.context_model_call_reservations WHERE run_date=v_date;
 IF v_ordinal>(v_pol->>'model_call_cap')::integer THEN RETURN jsonb_build_object('outcome','cap'); END IF;
 -- A1: attribution may use at most attribution_calls_day of the day's calls.
 IF p_phase='attribution' AND (SELECT count(*) FROM public.context_model_call_reservations
   WHERE run_date=v_date AND phase='attribution')>=(v_pol->>'attribution_calls_day')::integer
 THEN RETURN jsonb_build_object('outcome','attribution_budget','run_date',v_date,'limit',(v_pol->>'attribution_calls_day')::integer); END IF;
 -- ledger: only while the lane is switched on, within its own daily ceiling,
 -- and never inside its own live reserve (context_ledger_settings, all day and
 -- before noon), whatever reserve the fact backlog keeps.
 IF p_phase='ledger' THEN
  -- plain variables, read only here: no other phase depends on the ledger table
  SELECT st.mode, st.calls_per_day, st.live_reserve_calls, st.live_reserve_calls_morning
  INTO v_ledger_mode, v_ledger_calls, v_reserve_day, v_reserve_morning FROM public.context_ledger_settings st WHERE st.id;
  IF v_ledger_mode IS NULL OR v_ledger_mode='off' THEN RETURN jsonb_build_object('outcome','ledger_off'); END IF;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='ledger')>=v_ledger_calls
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','ledger_calls_per_day','run_date',v_date,'limit',v_ledger_calls); END IF;
  SELECT count(*) INTO v_calls FROM public.context_model_call_reservations WHERE run_date=v_date;
  IF v_calls>=(v_pol->>'model_call_cap')::integer-v_reserve_day
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','live_reserve','run_date',v_date,
   'ceiling',(v_pol->>'model_call_cap')::integer-v_reserve_day); END IF;
  IF (v_now AT TIME ZONE 'Australia/Perth')::time<(v_pol->>'morning_until')::time
   AND v_calls>=(v_pol->>'morning_cap')::integer-v_reserve_morning
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','live_reserve_morning','run_date',v_date,
   'ceiling',(v_pol->>'morning_cap')::integer-v_reserve_morning); END IF;
 END IF;
 -- story (20261009100000): the saved job story writer, only while its switch
 -- (feature_flags.context_job_story_text_v1) is on, within its own daily
 -- ceiling (context_job_story_text_policy calls_per_day), and never inside the
 -- ledger's live reserve lines (context_ledger_settings, all day and before
 -- noon), read as plain values so no other phase depends on either table.
 IF p_phase='story' THEN
  IF NOT public.context_job_story_text_on() THEN RETURN jsonb_build_object('outcome','story_off'); END IF;
  v_story_calls := (public.context_job_story_text_policy()->>'calls_per_day')::integer;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='story')>=v_story_calls
  THEN RETURN jsonb_build_object('outcome','story_budget','reason','story_calls_per_day','run_date',v_date,'limit',v_story_calls); END IF;
  SELECT st.live_reserve_calls, st.live_reserve_calls_morning
  INTO v_reserve_day, v_reserve_morning FROM public.context_ledger_settings st WHERE st.id;
  SELECT count(*) INTO v_calls FROM public.context_model_call_reservations WHERE run_date=v_date;
  IF v_reserve_day IS NULL OR v_calls>=(v_pol->>'model_call_cap')::integer-v_reserve_day
  THEN RETURN jsonb_build_object('outcome','story_budget','reason','live_reserve','run_date',v_date,
   'ceiling',(v_pol->>'model_call_cap')::integer-coalesce(v_reserve_day,(v_pol->>'model_call_cap')::integer)); END IF;
  IF (v_now AT TIME ZONE 'Australia/Perth')::time<(v_pol->>'morning_until')::time
   AND (v_reserve_morning IS NULL OR v_calls>=(v_pol->>'morning_cap')::integer-v_reserve_morning)
  THEN RETURN jsonb_build_object('outcome','story_budget','reason','live_reserve_morning','run_date',v_date,
   'ceiling',(v_pol->>'morning_cap')::integer-coalesce(v_reserve_morning,(v_pol->>'morning_cap')::integer)); END IF;
 END IF;
 -- B-5b: vision only while the job reads keep their share, and within its own daily cap.
 IF p_phase='vision' THEN
  IF v_ordinal>(public.context_document_vision_policy()->>'shared_calls_ceiling')::integer
  THEN RETURN jsonb_build_object('outcome','vision_reserve','run_date',v_date,
   'ceiling',(public.context_document_vision_policy()->>'shared_calls_ceiling')::integer); END IF;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='vision')
   >=public.context_document_vision_daily_cap()
  THEN RETURN jsonb_build_object('outcome','vision_budget','run_date',v_date,'limit',public.context_document_vision_daily_cap()); END IF;
 END IF;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,run_id,lease_token,reserved_at)
 VALUES(v_date,v_ordinal,p_phase,p_run_id,p_lease_token,v_now) RETURNING id INTO v_id;
 RETURN jsonb_build_object('outcome','reserved','reservation_id',v_id,'run_date',v_date,'ordinal',v_ordinal);
END $function$;

-- 2 of 7. context_ledger_budget: policy calls back on context_cadence_policy(): 1.
CREATE OR REPLACE FUNCTION public.context_ledger_budget()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.context_ledger_settings; v_pol jsonb; v_now timestamptz := clock_timestamp(); v_local timestamp; v_date date;
 v_total integer; v_max integer; v_ledger integer; r_cap integer; r_day integer; r_live integer; r_morning integer;
 v_left integer; v_reason text; v_midnight timestamptz; v_resets timestamptz; v_window jsonb;
BEGIN
 v_local := v_now AT TIME ZONE 'Australia/Perth';
 v_date := v_local::date;
 v_midnight := (v_date + 1)::timestamp AT TIME ZONE 'Australia/Perth';
 SELECT * INTO s FROM public.context_ledger_settings WHERE id;
 -- the backfill hours: backfills and rebuilds wait outside them, updates never do
 v_window := jsonb_build_object('backfill_window', jsonb_build_object('from_hour', s.backfill_from_hour, 'to_hour', s.backfill_to_hour,
  'open', public.context_ledger_backfill_open(s.backfill_from_hour, s.backfill_to_hour, v_now)));
 -- The admission's own order: lane, the day's cap (model_call_cap), the
 -- switch, the ledger's daily ceiling, its live reserve all day, then before
 -- morning_until.
 IF NOT public.automation_lane_enabled('extraction') THEN
  RETURN jsonb_build_object('mode', coalesce(s.mode, 'off'), 'lane_on', false, 'calls_left', 0, 'reason', 'lane_off', 'resets_at', NULL) || v_window;
 END IF;
 v_pol := public.context_cadence_policy();
 SELECT count(*)::integer, coalesce(max(m.ordinal), 0)::integer, (count(*) FILTER (WHERE m.phase = 'ledger'))::integer
 INTO v_total, v_max, v_ledger FROM public.context_model_call_reservations m WHERE m.run_date = v_date;
 r_cap := (v_pol ->> 'model_call_cap')::integer - v_max;
 IF r_cap <= 0 THEN
  RETURN jsonb_build_object('mode', coalesce(s.mode, 'off'), 'lane_on', true, 'calls_left', 0, 'reason', 'cap', 'resets_at', v_midnight) || v_window;
 END IF;
 IF s.id IS NULL OR s.mode = 'off' THEN
  RETURN jsonb_build_object('mode', 'off', 'lane_on', true, 'calls_left', 0, 'reason', 'ledger_off', 'resets_at', NULL) || v_window;
 END IF;
 r_day := s.calls_per_day - v_ledger;
 r_live := ((v_pol ->> 'model_call_cap')::integer - s.live_reserve_calls) - v_total;
 IF v_local::time < (v_pol ->> 'morning_until')::time THEN
  r_morning := ((v_pol ->> 'morning_cap')::integer - s.live_reserve_calls_morning) - v_total;
 END IF;
 v_left := greatest(0, least(r_cap, r_day, r_live, coalesce(r_morning, r_cap)));
 v_reason := CASE WHEN r_day <= 0 THEN 'ledger_calls_per_day' WHEN r_live <= 0 THEN 'live_reserve'
  WHEN r_morning <= 0 THEN 'live_reserve_morning' END;
 -- The line that binds resets with it: the morning line at morning_until,
 -- every other line at the next Perth midnight.
 v_resets := CASE WHEN r_morning IS NOT NULL AND r_morning <= least(r_cap, r_day, r_live)
  THEN (v_date + (v_pol ->> 'morning_until')::time) AT TIME ZONE 'Australia/Perth' ELSE v_midnight END;
 RETURN jsonb_build_object('mode', s.mode, 'lane_on', true, 'calls_left', v_left, 'reason', v_reason, 'resets_at', v_resets) || v_window;
END $function$;

-- 3 of 7. context_jobs_cadence: policy calls back on context_cadence_policy(): 1.
CREATE OR REPLACE FUNCTION public.context_jobs_cadence(p_job_ids uuid[])
 RETURNS TABLE(job_id uuid, cadence jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH k AS (
  SELECT pol.p, now() AS now_t, (now() AT TIME ZONE 'Australia/Perth') AS local_now, (now() AT TIME ZONE 'Australia/Perth')::date AS today,
   (pol.p->>'live_since')::timestamptz AS live_from,
   (((now() AT TIME ZONE 'Australia/Perth')::date)::timestamp+(pol.p->>'status_only_after')::time) AT TIME ZONE 'Australia/Perth' AS evening,
   public.automation_lane_enabled('extraction') AS lane,
   (SELECT count(*) FROM public.context_model_call_reservations r WHERE r.run_date=(now() AT TIME ZONE 'Australia/Perth')::date)::integer AS calls,
   -- backlog ceiling: the desk's live reserve, defaults when the row is missing.
   coalesce(s.live_reserve_calls_day,100) AS reserve_day, coalesce(s.live_reserve_calls_morning,100) AS reserve_morning,
   coalesce(s.live_reserve_reads_per_job,2) AS reserve_reads
  FROM (SELECT public.context_cadence_policy() AS p) pol LEFT JOIN public.context_cadence_settings s ON s.id
 ), j AS (
  -- catch-up: a listed job not yet done carries its priority and request time.
  SELECT jb.id, jb.created_at, coalesce(jb.metadata->>'do_not_schedule','') NOT IN ('true','1') AS extractable,
   cj.priority AS catchup_priority, cj.requested_at AS catchup_requested_at
  FROM public.jobs jb LEFT JOIN public.context_catchup_jobs cj ON cj.job_id=jb.id AND cj.done_at IS NULL
  WHERE jb.id=ANY(p_job_ids)
 ), u AS MATERIALIZED (
  -- Live evidence: captured since live_from, capture_mode live, written as
  -- service_role, and not the early relink case (a contact-rule placement,
  -- ladder step 3 or 4, of a row older than the job).
  SELECT x.job_id, x.id, greatest(x.context_captured_at,x.attributed_at) AS landed, public.context_event_status_only(x) AS so,
   (x.context_captured_at>=k.live_from AND coalesce(x.metadata->>'capture_mode','live')='live' AND x.metadata->>'written_as'='service_role'
    AND NOT (coalesce(x.attribution_step,0) IN (3,4) AND coalesce(x.event_at,x.occurred_at)<j.created_at)) AS live
  FROM public.context_unread_rows(p_job_ids) x JOIN j ON j.id=x.job_id CROSS JOIN k
 ), ev AS (
  SELECT u.job_id, count(*) AS unread_n, min(u.landed) AS oldest_unread,
   count(*) FILTER (WHERE u.live AND NOT u.so) AS wake_n,
   max(u.landed) FILTER (WHERE u.live AND NOT u.so) AS newest_wake, min(u.landed) FILTER (WHERE u.live AND NOT u.so) AS oldest_wake,
   (array_agg(u.id ORDER BY u.landed DESC NULLS LAST, u.id DESC) FILTER (WHERE u.live AND NOT u.so))[1] AS newest_wake_id,
   count(*) FILTER (WHERE u.live AND u.so) AS so_n, min(u.landed) FILTER (WHERE u.live AND u.so) AS oldest_so
  FROM u GROUP BY u.job_id
 ), cp AS (
  -- catch-up: rows still to read on a listed, not-yet-done job.
  SELECT x.job_id, count(*)::integer AS pending_n FROM public.context_catchup_pending_rows(p_job_ids) x GROUP BY x.job_id
 ), runs AS (
  SELECT r.job_id, count(*) FILTER (WHERE r.run_date=k.today) AS runs_today, max(r.started_at) AS last_started,
   max(r.finished_at) FILTER (WHERE r.status='done') AS last_finished,
   bool_or(r.status='running' AND r.lease_expires_at>k.now_t) AS run_live,
   max(r.retry_at) FILTER (WHERE r.status='failed' AND r.retry_at>k.now_t) AS retry_until,
   bool_or(r.run_date=k.today AND r.started_at>=k.evening) AS ran_evening
  FROM public.context_extraction_runs r CROSS JOIN k WHERE r.job_id=ANY(p_job_ids) AND r.phase='extraction' GROUP BY r.job_id
 ), base AS (
  SELECT j.id AS job_id, j.extractable, k.*,
   coalesce(ev.unread_n,0)::integer AS unread_n, ev.oldest_unread, coalesce(ev.wake_n,0)::integer AS wake_n, ev.newest_wake, ev.oldest_wake,
   coalesce(ev.so_n,0)::integer AS so_n, ev.oldest_so,
   coalesce((SELECT b.direction='inbound' AND NOT public.context_event_is_ours(b) FROM public.business_events b WHERE b.id=ev.newest_wake_id),false) AS customer,
   coalesce(runs.runs_today,0)::integer AS runs_today, runs.last_started, runs.last_finished, coalesce(runs.run_live,false) AS run_live,
   runs.retry_until, coalesce(runs.ran_evening,false) AS ran_evening,
   -- catch-up: listed, not done, and rows still to read.
   CASE WHEN coalesce(cp.pending_n,0)>0 THEN j.catchup_priority END AS catchup_priority, j.catchup_requested_at,
   coalesce(cp.pending_n,0) AS catchup_pending_n
  FROM j CROSS JOIN k LEFT JOIN ev ON ev.job_id=j.id LEFT JOIN runs ON runs.job_id=j.id LEFT JOIN cp ON cp.job_id=j.id
 ), limits AS (
  SELECT b.*,
   b.local_now::time<(b.p->>'morning_until')::time AND b.calls>=(b.p->>'morning_cap')::integer AS pacing,
   b.calls>=(b.p->>'model_call_cap')::integer AS capped,
   (b.p->>'runs_per_job_day')::integer+CASE WHEN b.customer AND public.context_in_business_hours(b.newest_wake) THEN (b.p->>'inbound_extra_runs')::integer ELSE 0 END AS run_limit,
   CASE WHEN b.wake_n>0 THEN least(b.newest_wake+make_interval(mins=>(b.p->>'quiet_min')::integer),b.oldest_wake+make_interval(mins=>(b.p->>'ceiling_min')::integer))
        -- catch-up: due from the request, ahead of the status-only evening read.
        WHEN b.catchup_priority IS NOT NULL THEN b.catchup_requested_at
        WHEN b.so_n>0 THEN CASE WHEN b.ran_evening THEN b.evening+interval '1 day' ELSE b.evening END END AS evidence_due,
   b.last_started+make_interval(mins=>(b.p->>'cooldown_min')::integer) AS cooldown_until,
   -- backlog ceiling: the catch-up rule, not live evidence, sets the due time.
   (b.catchup_priority IS NOT NULL AND b.wake_n=0) AS catchup_only
  FROM base b
 ), timed AS (
  SELECT l.*, greatest(l.evidence_due,l.cooldown_until,l.retry_until) AS due_at,
   -- backlog ceiling: every call of the Perth day counts; requested_at is never read.
   l.catchup_only AND l.calls>=(l.p->>'model_call_cap')::integer-l.reserve_day AS backlog_day,
   l.catchup_only AND l.local_now::time<(l.p->>'morning_until')::time AND l.calls>=(l.p->>'morning_cap')::integer-l.reserve_morning AS backlog_morning,
   l.catchup_only AND l.runs_today>=l.run_limit-l.reserve_reads AS backlog_job
  FROM limits l
 ), judged AS (
  SELECT t.*,
   (t.lane AND t.extractable AND t.evidence_due IS NOT NULL AND NOT t.run_live AND t.runs_today<t.run_limit AND NOT t.pacing AND NOT t.capped AND t.due_at<=t.now_t
    AND NOT (t.backlog_day OR t.backlog_morning OR t.backlog_job)) AS due,
   CASE WHEN NOT t.lane THEN 'lane_off' WHEN NOT t.extractable THEN 'holding_job' WHEN t.evidence_due IS NULL OR t.run_live THEN NULL
    WHEN t.runs_today>=t.run_limit THEN 'daily_ceiling' WHEN t.retry_until IS NOT NULL THEN 'retry_wait'
    WHEN t.capped THEN 'model_cap' WHEN t.pacing THEN 'pacing_reserve'
    WHEN t.backlog_day OR t.backlog_morning OR t.backlog_job THEN 'backlog_budget' END AS reason,
   CASE WHEN t.lane AND t.extractable AND t.evidence_due IS NOT NULL AND NOT t.run_live THEN
    greatest(t.due_at,t.now_t,
     CASE WHEN t.runs_today>=t.run_limit OR t.capped OR t.backlog_day OR t.backlog_job THEN (t.today+1)::timestamp AT TIME ZONE 'Australia/Perth' END,
     CASE WHEN t.pacing OR t.backlog_morning THEN (t.today::timestamp+(t.p->>'morning_until')::time) AT TIME ZONE 'Australia/Perth' END) END AS next_due
  FROM timed t
 )
 SELECT g.job_id, jsonb_build_object('job_id',g.job_id,'due',g.due,'due_since',CASE WHEN g.due THEN g.due_at END,'blocked_reason',g.reason,'next_due_at',g.next_due,
  'lane_on',g.lane,'extractable',g.extractable,'unread_count',g.unread_n,'oldest_unread_landed_at',g.oldest_unread,
  'waking_count',g.wake_n,'newest_waking_landed_at',g.newest_wake,'oldest_waking_landed_at',g.oldest_wake,'newest_waking_is_customer',g.customer,
  'status_only_count',g.so_n,'order_at',coalesce(g.oldest_wake,g.oldest_so),
  'runs_today',g.runs_today,'run_limit',g.run_limit,'run_live',g.run_live,'retry_at',g.retry_until,'cooldown_until',g.cooldown_until,
  'last_run_started_at',g.last_started,'last_run_finished_at',g.last_finished,
  'model_calls_today',g.calls,'pacing_held',g.pacing,'model_cap_reached',g.capped,
  -- catch-up: catchup_only is true when the catch-up rule, not live evidence, sets the due time.
  'catchup_priority',g.catchup_priority,'catchup_only',g.catchup_only,'catchup_pending_count',g.catchup_pending_n,
  -- backlog ceiling: a catch-up-only job held for the live reserve.
  'backlog_budget_held',(g.backlog_day OR g.backlog_morning OR g.backlog_job))
 FROM judged g
$function$;

-- 4 of 7. context_document_vision_admission: policy calls back on context_cadence_policy(): 1.
CREATE OR REPLACE FUNCTION public.context_document_vision_admission()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
 policy jsonb:=public.context_document_vision_policy();
 today date:=(clock_timestamp() AT TIME ZONE 'Australia/Perth')::date;
 used integer; vision_used integer; cap integer:=public.context_document_vision_daily_cap();
 ceiling integer:=(policy->>'shared_calls_ceiling')::integer; why text;
BEGIN
 SELECT count(*), count(*) FILTER (WHERE r.phase='vision') INTO used, vision_used
 FROM public.context_model_call_reservations r WHERE r.run_date=today;
 why:=CASE
  WHEN NOT (public.context_document_vision_flag()->>'enabled')::boolean THEN 'flag_off'
  WHEN NOT public.automation_lane_enabled('capture') OR NOT public.automation_lane_enabled('extraction') THEN 'paused'
  WHEN used>=(public.context_cadence_policy()->>'model_call_cap')::integer THEN 'cap'
  WHEN used>=ceiling THEN 'vision_reserve'
  WHEN vision_used>=cap THEN 'vision_budget'
 END;
 RETURN jsonb_build_object('open',why IS NULL,'code',why,'run_date',today,'calls_used_today',used,'vision_calls_today',vision_used,
  'vision_daily_cap',cap,'shared_calls_ceiling',ceiling);
END $function$;

-- 5 of 7. context_job_story_budget: policy calls back on context_cadence_policy(): 1.
CREATE OR REPLACE FUNCTION public.context_job_story_budget()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_pol jsonb; v_spol jsonb := public.context_job_story_text_policy(); v_now timestamptz := clock_timestamp(); v_local timestamp;
 v_date date; v_midnight timestamptz; v_on boolean; v_total integer; v_max integer; v_story integer; v_reserve_day integer;
 v_reserve_morning integer; r_cap integer; r_day integer; r_live integer; r_morning integer; v_left integer; v_reason text;
 v_resets timestamptz;
BEGIN
 v_local := v_now AT TIME ZONE 'Australia/Perth';
 v_date := v_local::date;
 v_midnight := (v_date + 1)::timestamp AT TIME ZONE 'Australia/Perth';
 v_on := public.context_job_story_text_on();
 IF NOT public.automation_lane_enabled('extraction') THEN
  RETURN jsonb_build_object('on', v_on, 'lane_on', false, 'calls_left', 0, 'reason', 'lane_off', 'resets_at', NULL, 'run_date', v_date,
   'calls_per_day', (v_spol ->> 'calls_per_day')::integer);
 END IF;
 v_pol := public.context_cadence_policy();
 SELECT count(*)::integer, coalesce(max(m.ordinal), 0)::integer, (count(*) FILTER (WHERE m.phase = 'story'))::integer
 INTO v_total, v_max, v_story FROM public.context_model_call_reservations m WHERE m.run_date = v_date;
 r_cap := (v_pol ->> 'model_call_cap')::integer - v_max;
 IF r_cap <= 0 THEN
  RETURN jsonb_build_object('on', v_on, 'lane_on', true, 'calls_left', 0, 'reason', 'cap', 'resets_at', v_midnight, 'run_date', v_date,
   'story_calls_today', v_story, 'calls_per_day', (v_spol ->> 'calls_per_day')::integer);
 END IF;
 IF NOT v_on THEN
  RETURN jsonb_build_object('on', false, 'lane_on', true, 'calls_left', 0, 'reason', 'story_off', 'resets_at', NULL, 'run_date', v_date,
   'story_calls_today', v_story, 'calls_per_day', (v_spol ->> 'calls_per_day')::integer);
 END IF;
 -- the ledger's live reserve lines, read as plain values (a missing settings row leaves nothing)
 SELECT st.live_reserve_calls, st.live_reserve_calls_morning INTO v_reserve_day, v_reserve_morning
 FROM public.context_ledger_settings st WHERE st.id;
 r_day := (v_spol ->> 'calls_per_day')::integer - v_story;
 r_live := CASE WHEN v_reserve_day IS NULL THEN 0 ELSE ((v_pol ->> 'model_call_cap')::integer - v_reserve_day) - v_total END;
 IF v_local::time < (v_pol ->> 'morning_until')::time THEN
  r_morning := CASE WHEN v_reserve_morning IS NULL THEN 0 ELSE ((v_pol ->> 'morning_cap')::integer - v_reserve_morning) - v_total END;
 END IF;
 v_left := greatest(0, least(r_cap, r_day, r_live, coalesce(r_morning, r_cap)));
 v_reason := CASE WHEN r_day <= 0 THEN 'story_calls_per_day' WHEN r_live <= 0 THEN 'live_reserve'
  WHEN r_morning <= 0 THEN 'live_reserve_morning' END;
 v_resets := CASE WHEN r_morning IS NOT NULL AND r_morning <= least(r_cap, r_day, r_live)
  THEN (v_date + (v_pol ->> 'morning_until')::time) AT TIME ZONE 'Australia/Perth' ELSE v_midnight END;
 RETURN jsonb_build_object('on', true, 'lane_on', true, 'calls_left', v_left, 'reason', v_reason, 'resets_at', v_resets, 'run_date', v_date,
  'story_calls_today', v_story, 'calls_per_day', (v_spol ->> 'calls_per_day')::integer);
END $function$;

-- 6 of 7. context_cadence_status: policy calls back on context_cadence_policy(): 1.
CREATE OR REPLACE FUNCTION public.context_cadence_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE pol jsonb:=public.context_cadence_policy(); now_t timestamptz:=now(); today date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 lane boolean; attribution_lane boolean; calls integer; attribution_calls integer; judged jsonb; due_n integer; waiting_n integer;
 ceiling_n integer; pacing_n integer; oldest_unread timestamptz; oldest_wait numeric; breach boolean;
 runs integer; jobs_run integer; max_runs integer; takeovers integer; not_service integer; unplaced_n integer; oldest_unplaced timestamptz; alarms jsonb:='[]'::jsonb;
 catchup jsonb;
 held_n integer; held_wait numeric; backlog_n integer; worker_breach boolean; held_breach boolean; reserve jsonb; what text;
BEGIN
 lane:=public.automation_lane_enabled('extraction'); attribution_lane:=public.automation_lane_enabled('attribution');
 SELECT count(*), count(*) FILTER (WHERE phase='attribution') INTO calls, attribution_calls FROM public.context_model_call_reservations WHERE run_date=today;
 SELECT coalesce(jsonb_agg(x.cadence),'[]'::jsonb) INTO judged
  FROM public.context_jobs_cadence(ARRAY(SELECT p.job_id FROM public.context_cadence_pool() AS p(job_id))) x;
 SELECT count(*) FILTER (WHERE (c->>'due')::boolean),
  count(*) FILTER (WHERE NOT (c->>'due')::boolean AND (coalesce((c->>'waking_count')::integer,0)+coalesce((c->>'status_only_count')::integer,0))>0),
  count(*) FILTER (WHERE c->>'blocked_reason'='daily_ceiling'), count(*) FILTER (WHERE c->>'blocked_reason'='pacing_reserve'),
  min((c->>'order_at')::timestamptz),
  max(extract(epoch FROM now_t-(c->>'due_since')::timestamptz)/60) FILTER (WHERE (c->>'due')::boolean AND NOT coalesce((c->>'catchup_only')::boolean,false)),
  -- backlog ceiling: a job with live waking evidence held by the day's budget,
  -- measured from when its evidence made it due (K1's quiet and ceiling times).
  count(*) FILTER (WHERE NOT (c->>'due')::boolean AND coalesce((c->>'waking_count')::integer,0)>0
   AND c->>'blocked_reason' IN ('model_cap','pacing_reserve','backlog_budget')),
  max(extract(epoch FROM now_t-least((c->>'newest_waking_landed_at')::timestamptz+make_interval(mins=>(pol->>'quiet_min')::integer),
    (c->>'oldest_waking_landed_at')::timestamptz+make_interval(mins=>(pol->>'ceiling_min')::integer)))/60)
   FILTER (WHERE NOT (c->>'due')::boolean AND coalesce((c->>'waking_count')::integer,0)>0
    AND c->>'blocked_reason' IN ('model_cap','pacing_reserve','backlog_budget')),
  count(*) FILTER (WHERE c->>'blocked_reason'='backlog_budget')
 INTO due_n, waiting_n, ceiling_n, pacing_n, oldest_unread, oldest_wait, held_n, held_wait, backlog_n FROM jsonb_array_elements(judged) AS c;
 worker_breach:=lane AND calls<(pol->>'model_call_cap')::integer AND coalesce(oldest_wait,0)>(pol->>'breach_wait_min')::integer;
 held_breach:=lane AND coalesce(held_wait,0)>(pol->>'breach_wait_min')::integer;
 breach:=worker_breach OR held_breach;
 SELECT jsonb_build_object('calls_day',coalesce(s.live_reserve_calls_day,100),'calls_morning',coalesce(s.live_reserve_calls_morning,100),
  'reads_per_job',coalesce(s.live_reserve_reads_per_job,2),
  'backlog_ceiling_day',(pol->>'model_call_cap')::integer-coalesce(s.live_reserve_calls_day,100),
  'backlog_ceiling_morning',(pol->>'morning_cap')::integer-coalesce(s.live_reserve_calls_morning,100),
  'settings_row',s.id IS NOT NULL)
 INTO reserve FROM (SELECT 1) one LEFT JOIN public.context_cadence_settings s ON s.id;
 SELECT count(*), count(DISTINCT job_id), coalesce(max(n),0) INTO runs, jobs_run, max_runs
  FROM (SELECT job_id, count(*) OVER (PARTITION BY job_id) AS n FROM public.context_extraction_runs WHERE run_date=today AND phase='extraction') r;
 SELECT coalesce(sum(lease_takeovers),0) INTO takeovers FROM public.context_pass_days WHERE run_date=today;
 SELECT count(*) INTO not_service FROM public.business_events
  WHERE context_captured_at>now_t-interval '24 hours' AND metadata ? 'written_as' AND metadata->>'written_as'<>'service_role';
 SELECT count(*), min(coalesce(event_at,occurred_at)) INTO unplaced_n, oldest_unplaced FROM public.business_events WHERE attribution_status='unplaced';
 -- catch-up: remaining = not done; of those, due now, and nothing to read (no
 -- placed worded rows, so the job stays remaining until evidence lands).
 SELECT jsonb_build_object('requested',count(*),'done',count(*) FILTER (WHERE cj.done_at IS NOT NULL),
  'remaining',count(*) FILTER (WHERE cj.done_at IS NULL),
  'remaining_priority_1',count(*) FILTER (WHERE cj.done_at IS NULL AND cj.priority=1),
  'remaining_priority_2',count(*) FILTER (WHERE cj.done_at IS NULL AND cj.priority=2),
  'due_now',count(*) FILTER (WHERE cj.done_at IS NULL AND (jc.c->>'due')::boolean),
  'remaining_nothing_to_read',count(*) FILTER (WHERE cj.done_at IS NULL AND coalesce((jc.c->>'catchup_pending_count')::integer,0)=0),
  'oldest_requested_at',min(cj.requested_at) FILTER (WHERE cj.done_at IS NULL),
  'last_done_at',max(cj.done_at))
 INTO catchup
 FROM public.context_catchup_jobs cj
 LEFT JOIN (SELECT (c->>'job_id')::uuid AS job_id, c FROM jsonb_array_elements(judged) AS c) jc ON jc.job_id=cj.job_id;
 IF breach THEN
  what:=concat_ws(' ',
   CASE WHEN worker_breach THEN 'A job has been due for a read for more than 90 minutes with the extraction lane on and model budget left. Check that the Luna context worker is running and ticking.' END,
   CASE WHEN held_breach THEN 'A job with new evidence has waited more than 90 minutes because the day''s model calls are spent. Check what spent them (catch-up and backlog reads stop at the live reserve in context_cadence_settings).' END);
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','cadence_breach','severity','warning',
   'since',now_t-make_interval(secs=>greatest(coalesce(oldest_wait,0),coalesce(held_wait,0))*60),
   'oldest_due_wait_minutes',CASE WHEN oldest_wait IS NULL THEN NULL ELSE round(oldest_wait) END,
   'oldest_held_wait_minutes',CASE WHEN held_wait IS NULL THEN NULL ELSE round(held_wait) END,
   'cause',CASE WHEN worker_breach AND held_breach THEN 'worker_and_budget' WHEN worker_breach THEN 'worker' ELSE 'budget' END,
   'what_to_do',what));
 END IF;
 RETURN jsonb_build_object('as_of',now_t,'policy',pol,
  'lanes',jsonb_build_object('extraction',lane,'attribution',attribution_lane),
  'due_jobs',due_n,'waiting_jobs',waiting_n,'oldest_unread_landed_at',oldest_unread,
  'oldest_due_wait_minutes',CASE WHEN oldest_wait IS NULL THEN NULL ELSE round(oldest_wait) END,'cadence_breach',breach,
  'runs_today',runs,'jobs_run_today',jobs_run,'max_runs_one_job_today',max_runs,
  'jobs_at_daily_ceiling',ceiling_n,'pacing_held_jobs',pacing_n,'lease_takeovers_today',takeovers,
  'model_calls_today',calls,'attribution_calls_today',attribution_calls,
  'unplaced_count',unplaced_n,'oldest_unplaced_at',oldest_unplaced,
  'rows_not_service_role_24h',not_service,'catchup',catchup,
  'live_held_by_budget_jobs',held_n,'oldest_held_wait_minutes',CASE WHEN held_wait IS NULL THEN NULL ELSE round(held_wait) END,
  'backlog_budget_held_jobs',backlog_n,'read_reserve',reserve,
  'alarms',alarms);
END $function$;

-- 7 of 7. context_core_status: policy calls back on context_cadence_policy(): 2.
CREATE OR REPLACE FUNCTION public.context_core_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d date:=(now() AT TIME ZONE 'Australia/Perth')::date; switches jsonb; queue jsonb; calls integer; call_state text:='available'; ready integer;
BEGIN
 SELECT to_jsonb(s) INTO switches FROM public.automation_switches s WHERE id=1;
 SELECT jsonb_object_agg(status,n) INTO queue FROM (SELECT coalesce(e.attribution_status,'unknown') status,count(*) n
 FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 GROUP BY e.attribution_status) q;
 BEGIN
  EXECUTE 'SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=$1' INTO calls USING d;
 EXCEPTION WHEN OTHERS THEN calls:=NULL;call_state:='unavailable'; END;
 ready:=public.context_ready_jobs_count(400);
 RETURN jsonb_build_object('as_of',now(),'run_date',d,'switches',switches,
  'lanes',jsonb_build_object('capture',public.automation_lane_enabled('capture'),'attribution',public.automation_lane_enabled('attribution'),'extraction',public.automation_lane_enabled('extraction')),
  'runs_used',(SELECT count(*) FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction'),'run_cap',(public.context_cadence_policy()->>'model_call_cap')::integer,
  'runs_by_status',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' GROUP BY status) s),
  'failed_by_error',(SELECT coalesce(jsonb_object_agg(coalesce(nullif(error,''),'(none)'),n),'{}'::jsonb) FROM (SELECT error,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' AND status='failed' GROUP BY error) s),
  'model_calls_used',calls,'model_call_cap',(public.context_cadence_policy()->>'model_call_cap')::integer,'model_call_budget_state',call_state,
  'evidence_by_attribution_status',coalesce(queue,'{}'::jsonb),'ready_jobs',ready,'ready_jobs_is_lower_bound',ready=400,
  'admin_bucket_size',(SELECT count(*) FROM public.business_events WHERE attribution_status='admin_bucket'),
  'missing_event_time',(SELECT count(*) FROM public.business_events WHERE event_at IS NULL AND occurred_at IS NULL AND attribution_status NOT IN ('empty','automated')),
  'oldest_pending_event_at',(SELECT min(coalesce(e.event_at, e.occurred_at)) FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated') AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')),
  'last_pass_finished_at',(SELECT max(finished_at) FROM public.context_pass_days WHERE status='done'),
  'today_pass',(SELECT to_jsonb(p) FROM public.context_pass_days p WHERE run_date=d),
  'coverage',public.context_coverage(),
  'actor_missing',public.context_actor_missing_status());
END $function$;

REVOKE ALL ON FUNCTION
 public.reserve_context_model_call(text,uuid,uuid),
 public.context_ledger_budget(),
 public.context_jobs_cadence(uuid[]),
 public.context_document_vision_admission(),
 public.context_job_story_budget(),
 public.context_cadence_status(),
 public.context_core_status()
 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
 public.reserve_context_model_call(text,uuid,uuid),
 public.context_ledger_budget(),
 public.context_jobs_cadence(uuid[]),
 public.context_document_vision_admission(),
 public.context_job_story_budget(),
 public.context_cadence_status(),
 public.context_core_status()
 TO service_role;

DROP FUNCTION IF EXISTS public.context_cadence_policy_today();

-- The CHECKs back to 1,000.
DO $chk$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = 'CHECK (((ordinal >= 1) AND (ordinal <= 3000)))' LOOP
  EXECUTE format('ALTER TABLE public.context_model_call_reservations DROP CONSTRAINT %I', c.conname);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) LIKE 'CHECK (((ordinal >= 1) AND (ordinal <= 1000)))%') THEN
  IF EXISTS (SELECT 1 FROM public.context_model_call_reservations WHERE ordinal > 1000) THEN
   ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_ordinal_check
    CHECK (ordinal BETWEEN 1 AND 1000) NOT VALID;
  ELSE
   ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_ordinal_check
    CHECK (ordinal BETWEEN 1 AND 1000);
  END IF;
 END IF;
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.context_ledger_settings'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = 'CHECK (((calls_per_day >= 0) AND (calls_per_day <= 3000)))' LOOP
  EXECUTE format('ALTER TABLE public.context_ledger_settings DROP CONSTRAINT %I', c.conname);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_ledger_settings'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) LIKE 'CHECK (((calls_per_day >= 0) AND (calls_per_day <= 1000)))%') THEN
  IF EXISTS (SELECT 1 FROM public.context_ledger_settings WHERE calls_per_day > 1000) THEN
   ALTER TABLE public.context_ledger_settings ADD CONSTRAINT context_ledger_settings_calls_per_day_check
    CHECK (calls_per_day BETWEEN 0 AND 1000) NOT VALID;
  ELSE
   ALTER TABLE public.context_ledger_settings ADD CONSTRAINT context_ledger_settings_calls_per_day_check
    CHECK (calls_per_day BETWEEN 0 AND 1000);
  END IF;
 END IF;
END $chk$;

ALTER TABLE public.context_ledger_settings DROP COLUMN IF EXISTS read_concurrency;

COMMENT ON TABLE public.context_ledger_settings IS
 'Context ledger: the ledger lane''s switch (20261006010000). mode off = no reads; shadow = read jobs into shadow generations nobody is shown; live = promote passing generations and keep them current. calls_per_day is the lane''s own ceiling inside the day''s shared model calls (context_cadence_policy model_call_cap, 1000 a Perth day since the call budget 20261006060000), 0 to 1000; the live reserve still applies. live_reserve_calls and live_reserve_calls_morning are the calls the ledger always leaves free for live fact reads (its own line, apart from the fact backlog''s context_cadence_settings). job_ids limits which jobs are read (NULL = every live job). One row; seeded off with 0 calls, a 100-call reserve both ways and no list. Service role only.';

DO $verify$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', '25a5b5f208af726d47e952f98cecef56'),
  ('public.context_ledger_budget()', '8f7b42529db2e1062283de005cef01a7'),
  ('public.context_jobs_cadence(uuid[])', 'c711479690d167f09d016f0413f11160'),
  ('public.context_document_vision_admission()', 'f1d33b0f0ee54516941ee313cb7fe756'),
  ('public.context_job_story_budget()', 'bd32ab0faece36527b05abdce0474f47'),
  ('public.context_cadence_status()', '85e60d754e65b812b28e798435e2a5a4'),
  ('public.context_core_status()', '2b6b2c54daeae381cdeff7802d72df81')
 ) AS t(sig, want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.want THEN
   RAISE EXCEPTION 'context_call_cap_setting_down: % md5 % is not the earlier body', x.sig, coalesce(live, '<missing>');
  END IF;
 END LOOP;
END $verify$;
