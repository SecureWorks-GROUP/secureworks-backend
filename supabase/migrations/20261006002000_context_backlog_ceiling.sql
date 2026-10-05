-- A live reserve inside the day's model calls (5 Oct 2026).
--
-- Live and backlog reads shared one 400-a-day pool and one 300-before-noon
-- reserve with nothing kept back for live work. A catch-up or backlog job is
-- due the moment it is listed, so whenever no live job was due the worker spent
-- calls on the backlog, and once the morning 300 or the day's 400 was spent
-- every read waited, live included, until noon or Perth midnight (measured
-- 5 Oct 02:10Z: 301 calls by 10:10 Perth, 448 jobs held by pacing).
--
-- This migration keeps a live reserve, the same pattern as attribution's 60:
--
--   context_cadence_settings  new one-row table, the desk's tunable live
--                             reserve: live_reserve_calls_day (100),
--                             live_reserve_calls_morning (100) and
--                             live_reserve_reads_per_job (2). Service role
--                             only. A missing row reads as these defaults.
--   context_jobs_cadence      a catch-up-only job (listed, pending rows, no
--                             live waking evidence: the existing catchup_only)
--                             is not due, blocked_reason backlog_budget, once
--                             any of these holds:
--                               the Perth day's calls >= model_call_cap minus
--                               the day reserve (400 - 100 = 300);
--                               before morning_until, calls >= morning_cap
--                               minus the morning reserve (300 - 100 = 200);
--                               the job's reads today >= its run limit minus
--                               the per-job reserve (6 - 2 = 4).
--                             The ceiling counts every call of the day and
--                             never reads requested_at, so a re-list that
--                             sets requested_at = now() cannot get past it.
--                             A job with live waking evidence is never
--                             catch-up-only, so live reads keep the remaining
--                             calls and at least two reads a job. Every other
--                             rule, reason and number is unchanged. New output
--                             key backlog_budget_held.
--   claim_context_extraction_run  refuses a job whose blocked_reason is
--                             backlog_budget with outcome pacing, reason
--                             backlog_budget (the worker already
--                             skips pacing), so a candidate list taken just
--                             before the ceiling cannot start another backlog
--                             read. Otherwise K1's body.
--   context_cadence_status    cadence_breach is also raised when a job with
--                             live waking evidence has been held by model_cap,
--                             pacing_reserve or backlog_budget for more than
--                             breach_wait_min past the time its evidence made
--                             it due. Before, a held job was not due and so
--                             never counted, and the alarm needed calls below
--                             the cap: the empty-pool hours were silent. The
--                             worker case (a due job waiting with budget left)
--                             is unchanged. New keys: live_held_by_budget_jobs,
--                             oldest_held_wait_minutes, backlog_budget_held_jobs,
--                             read_reserve.
--
-- Unchanged: context_cadence_policy() (every cap, live_since), the pool, the
-- candidate order, the batch, the flags, the catch-up list and its writers,
-- reserve_context_model_call (the 400 cap and attribution's 60).
-- Replaced functions: public.context_jobs_cadence(uuid[]),
-- public.context_cadence_status(), public.claim_context_extraction_run(uuid,date,text).
-- Tune: UPDATE public.context_cadence_settings SET live_reserve_calls_day=..;
-- all three set to 0 is the old behaviour. Rollback:
-- supabase/rollbacks/20261006002000_context_backlog_ceiling_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Each replaced function must be its current repository
-- body (20260924220000 for the cadence and status, K1 20260924030000 for the
-- claim) or this migration's (re-apply). The settings table must be absent or
-- this migration's.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_jobs_cadence(uuid[])',ARRAY['184bfbf98717e2a85cfaed282bcca9a6','c711479690d167f09d016f0413f11160']),
  ('public.context_cadence_status()',ARRAY['552d7971757d43624ec3667e3dc1fb99','85e60d754e65b812b28e798435e2a5a4']),
  ('public.claim_context_extraction_run(uuid,date,text)',ARRAY['ac6f021c77dbf0e44a949ea94d24f666','0e31f4c0017a05a004e420907f8bc73a'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regprocedure('public.context_cadence_policy()') IS NULL THEN problems:=problems||'public.context_cadence_policy() is missing'::text; END IF;
 IF to_regclass('public.context_cadence_settings') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_description d
   WHERE d.objoid=to_regclass('public.context_cadence_settings') AND d.classoid='pg_class'::regclass AND d.objsubid=0 AND d.description LIKE 'Live reserve:%')
 THEN problems:=problems||'public.context_cadence_settings already exists and is not this migration''s'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_backlog_ceiling_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The desk's live reserve. One row (id true). A missing row means defaults.
CREATE TABLE IF NOT EXISTS public.context_cadence_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 live_reserve_calls_day integer NOT NULL DEFAULT 100 CHECK (live_reserve_calls_day>=0),
 live_reserve_calls_morning integer NOT NULL DEFAULT 100 CHECK (live_reserve_calls_morning>=0),
 live_reserve_reads_per_job integer NOT NULL DEFAULT 2 CHECK (live_reserve_reads_per_job>=0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 note text
);
COMMENT ON TABLE public.context_cadence_settings IS
 'Live reserve: model calls and reads kept back from catch-up and backlog reads (20261006002000). A catch-up-only job is not due (backlog_budget) once the Perth day''s calls reach model_call_cap minus live_reserve_calls_day, or before morning_until morning_cap minus live_reserve_calls_morning, or its reads today reach its run limit minus live_reserve_reads_per_job. One row; a missing row reads as 100, 100, 2; all 0 is the old shared pool. Service role only.';
ALTER TABLE public.context_cadence_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_cadence_settings FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.context_cadence_settings TO service_role;
INSERT INTO public.context_cadence_settings(id) VALUES(true) ON CONFLICT (id) DO NOTHING;

-- 2. The cadence judgement: 20260924220000's body plus the backlog ceiling
-- (marked "backlog ceiling").
CREATE OR REPLACE FUNCTION public.context_jobs_cadence(p_job_ids uuid[]) RETURNS TABLE(job_id uuid, cadence jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
$$;
COMMENT ON FUNCTION public.context_jobs_cadence(uuid[]) IS
 'K1: the one cadence judgement (cadence.md 5.1) for a set of jobs: due, blocked_reason, next_due_at and the facts behind them. Read by the claim, candidates, freshness and status. Catch-up (20260924220000): a listed, not-yet-done job with pending rows is due from its request time. Backlog ceiling (20261006002000): a catch-up-only job is held backlog_budget once the day''s calls reach the live reserve in context_cadence_settings or the job has used its reads less the per-job reserve.';

-- 3. The claim: K1's body plus one refusal (marked "backlog ceiling").
CREATE OR REPLACE FUNCTION public.claim_context_extraction_run(p_job_id uuid,p_run_date date,p_phase text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.context_extraction_runs; had_run boolean; v_lane text; c jsonb; lease interval;
BEGIN
 IF p_job_id IS NULL OR p_run_date IS DISTINCT FROM (now() AT TIME ZONE 'Australia/Perth')::date
 OR p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket') THEN
  RAISE EXCEPTION 'Invalid context run identity';
 END IF;
 v_lane := CASE WHEN p_phase='extraction' THEN 'extraction' ELSE 'attribution' END;
 IF NOT public.automation_lane_enabled(v_lane) THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 lease:=make_interval(mins=>(public.context_cadence_policy()->>'run_lease_min')::integer);
 SELECT * INTO r FROM public.context_extraction_runs WHERE job_id=p_job_id AND run_date=p_run_date AND phase=p_phase
  ORDER BY run_seq DESC LIMIT 1 FOR UPDATE;
 had_run:=FOUND;
 IF p_phase<>'extraction' THEN
  IF had_run THEN
   IF r.status IN ('done','skipped') THEN RETURN jsonb_build_object('outcome','done','run',to_jsonb(r)); END IF;
   IF r.retry_at > now() THEN RETURN jsonb_build_object('outcome','paused','retry_at',r.retry_at,'run',to_jsonb(r)); END IF;
   IF r.status='running' AND r.lease_expires_at > now() THEN RETURN jsonb_build_object('outcome','busy','run',to_jsonb(r)); END IF;
   UPDATE public.context_extraction_runs SET status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+lease,
     retry_at=NULL,finished_at=NULL,attempts=attempts+1 WHERE id=r.id RETURNING * INTO r;
  ELSE
   INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,lease_token,lease_expires_at)
    VALUES(p_job_id,p_run_date,p_phase,'running',gen_random_uuid(),now()+lease) RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('outcome','claimed','run',to_jsonb(r));
 END IF;
 c:=public.context_job_cadence(p_job_id);
 IF c IS NULL THEN RAISE EXCEPTION 'Invalid context run identity'; END IF;
 IF (c->>'run_live')::boolean THEN RETURN jsonb_build_object('outcome','busy','run',to_jsonb(r)); END IF;
 IF c->>'retry_at' IS NOT NULL THEN RETURN jsonb_build_object('outcome','paused','retry_at',(c->>'retry_at')::timestamptz,'reason','retry_wait'); END IF;
 IF (c->>'pacing_held')::boolean THEN RETURN jsonb_build_object('outcome','pacing','reason','pacing_reserve'); END IF;
 -- backlog ceiling: a catch-up-only job leaves the live reserve alone. Only
 -- when the judgement's own reason is backlog_budget, so every K1 outcome
 -- (busy, retry wait, pacing, daily ceiling) keeps its precedence.
 IF c->>'blocked_reason'='backlog_budget' THEN RETURN jsonb_build_object('outcome','pacing','reason','backlog_budget'); END IF;
 IF had_run AND r.status IN ('running','failed') THEN
  -- The same run again: its lease ran out, or its retry time has passed.
  UPDATE public.context_extraction_runs SET status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+lease,
    retry_at=NULL,finished_at=NULL,attempts=attempts+1 WHERE id=r.id RETURNING * INTO r;
  RETURN jsonb_build_object('outcome','claimed','run',to_jsonb(r));
 END IF;
 IF (c->>'runs_today')::integer>=(c->>'run_limit')::integer THEN
  RETURN jsonb_build_object('outcome','ceiling','reason','daily_ceiling','runs_today',(c->>'runs_today')::integer,'run_limit',(c->>'run_limit')::integer);
 END IF;
 IF (c->>'cooldown_until')::timestamptz>now() THEN
  RETURN jsonb_build_object('outcome','paused','retry_at',(c->>'cooldown_until')::timestamptz,'reason','cooldown');
 END IF;
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,lease_token,lease_expires_at,run_seq)
  VALUES(p_job_id,p_run_date,'extraction','running',gen_random_uuid(),now()+lease,coalesce(r.run_seq,0)+1) RETURNING * INTO r;
 RETURN jsonb_build_object('outcome','claimed','run',to_jsonb(r));
END $$;

-- 4. The status block: 20260924220000's block plus the held-live breach and
-- the reserve (marked "backlog ceiling").
CREATE OR REPLACE FUNCTION public.context_cadence_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;
COMMENT ON FUNCTION public.context_cadence_status() IS
 'Status block cadence, owned by cadence slice K1 (cadence.md 9.A item 9). Due and waiting jobs from context_job_cadence, runs today, ceiling and pacing holds, lease takeovers, unplaced rows, rows not written as service_role, the cadence_breach alarm (jobs due only by catch-up excluded), and the catch-up progress block (20260924220000). Since 20261006002000 cadence_breach also fires when a job with live waking evidence is held by model_cap, pacing_reserve or backlog_budget past breach_wait_min, and the block publishes the live reserve (read_reserve) and the held counts.';

-- 5. Grants: service role only.
REVOKE ALL ON FUNCTION public.context_jobs_cadence(uuid[]),public.context_cadence_status(),public.claim_context_extraction_run(uuid,date,text)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_jobs_cadence(uuid[]),public.context_cadence_status(),public.claim_context_extraction_run(uuid,date,text)
TO service_role;
