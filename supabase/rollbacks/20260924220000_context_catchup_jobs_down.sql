-- Down migration for 20260924220000_context_catchup_jobs.
--
-- Restores the four replaced functions to K1's bodies (20260924030000), byte
-- for byte (md5 checked at the end), and drops the catch-up writer, the
-- pending-rows read and both triggers. Kept on purpose (no data is lost):
-- public.context_catchup_jobs and public.context_catchup_reads with their
-- rows, the record of which jobs were listed, which rows were read and when.
-- Nothing reads it after this rollback, and a re-apply resumes from it.
-- Immediate stop needs no rollback: switch the extraction lane off.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DROP TRIGGER IF EXISTS context_catchup_mark_done ON public.context_extraction_runs;
DROP FUNCTION IF EXISTS public.context_catchup_mark_done();
DROP FUNCTION IF EXISTS public.context_catchup_request(boolean);
DROP TRIGGER IF EXISTS context_catchup_record_read ON public.context_extraction_event_receipts;
DROP FUNCTION IF EXISTS public.context_catchup_record_read();

-- The cadence judgement (cadence.md 5.1), set-based so the tick and the
-- heartbeat judge every job in one query. The one definition: the claim,
-- candidates, freshness and status all take their answer from here.
CREATE OR REPLACE FUNCTION public.context_jobs_cadence(p_job_ids uuid[]) RETURNS TABLE(job_id uuid, cadence jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH k AS (
  SELECT pol.p, now() AS now_t, (now() AT TIME ZONE 'Australia/Perth') AS local_now, (now() AT TIME ZONE 'Australia/Perth')::date AS today,
   (pol.p->>'live_since')::timestamptz AS live_from,
   (((now() AT TIME ZONE 'Australia/Perth')::date)::timestamp+(pol.p->>'status_only_after')::time) AT TIME ZONE 'Australia/Perth' AS evening,
   public.automation_lane_enabled('extraction') AS lane,
   (SELECT count(*) FROM public.context_model_call_reservations r WHERE r.run_date=(now() AT TIME ZONE 'Australia/Perth')::date)::integer AS calls
  FROM (SELECT public.context_cadence_policy() AS p) pol
 ), j AS (
  SELECT jb.id, jb.created_at, coalesce(jb.metadata->>'do_not_schedule','') NOT IN ('true','1') AS extractable
  FROM public.jobs jb WHERE jb.id=ANY(p_job_ids)
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
   runs.retry_until, coalesce(runs.ran_evening,false) AS ran_evening
  FROM j CROSS JOIN k LEFT JOIN ev ON ev.job_id=j.id LEFT JOIN runs ON runs.job_id=j.id
 ), limits AS (
  SELECT b.*,
   b.local_now::time<(b.p->>'morning_until')::time AND b.calls>=(b.p->>'morning_cap')::integer AS pacing,
   b.calls>=(b.p->>'model_call_cap')::integer AS capped,
   (b.p->>'runs_per_job_day')::integer+CASE WHEN b.customer AND public.context_in_business_hours(b.newest_wake) THEN (b.p->>'inbound_extra_runs')::integer ELSE 0 END AS run_limit,
   CASE WHEN b.wake_n>0 THEN least(b.newest_wake+make_interval(mins=>(b.p->>'quiet_min')::integer),b.oldest_wake+make_interval(mins=>(b.p->>'ceiling_min')::integer))
        WHEN b.so_n>0 THEN CASE WHEN b.ran_evening THEN b.evening+interval '1 day' ELSE b.evening END END AS evidence_due,
   b.last_started+make_interval(mins=>(b.p->>'cooldown_min')::integer) AS cooldown_until
  FROM base b
 ), timed AS (
  SELECT l.*, greatest(l.evidence_due,l.cooldown_until,l.retry_until) AS due_at FROM limits l
 ), judged AS (
  SELECT t.*,
   (t.lane AND t.extractable AND t.evidence_due IS NOT NULL AND NOT t.run_live AND t.runs_today<t.run_limit AND NOT t.pacing AND NOT t.capped AND t.due_at<=t.now_t) AS due,
   CASE WHEN NOT t.lane THEN 'lane_off' WHEN NOT t.extractable THEN 'holding_job' WHEN t.evidence_due IS NULL OR t.run_live THEN NULL
    WHEN t.runs_today>=t.run_limit THEN 'daily_ceiling' WHEN t.retry_until IS NOT NULL THEN 'retry_wait'
    WHEN t.capped THEN 'model_cap' WHEN t.pacing THEN 'pacing_reserve' END AS reason,
   CASE WHEN t.lane AND t.extractable AND t.evidence_due IS NOT NULL AND NOT t.run_live THEN
    greatest(t.due_at,t.now_t,
     CASE WHEN t.runs_today>=t.run_limit OR t.capped THEN (t.today+1)::timestamp AT TIME ZONE 'Australia/Perth' END,
     CASE WHEN t.pacing THEN (t.today::timestamp+(t.p->>'morning_until')::time) AT TIME ZONE 'Australia/Perth' END) END AS next_due
  FROM timed t
 )
 SELECT g.job_id, jsonb_build_object('job_id',g.job_id,'due',g.due,'due_since',CASE WHEN g.due THEN g.due_at END,'blocked_reason',g.reason,'next_due_at',g.next_due,
  'lane_on',g.lane,'extractable',g.extractable,'unread_count',g.unread_n,'oldest_unread_landed_at',g.oldest_unread,
  'waking_count',g.wake_n,'newest_waking_landed_at',g.newest_wake,'oldest_waking_landed_at',g.oldest_wake,'newest_waking_is_customer',g.customer,
  'status_only_count',g.so_n,'order_at',coalesce(g.oldest_wake,g.oldest_so),
  'runs_today',g.runs_today,'run_limit',g.run_limit,'run_live',g.run_live,'retry_at',g.retry_until,'cooldown_until',g.cooldown_until,
  'last_run_started_at',g.last_started,'last_run_finished_at',g.last_finished,
  'model_calls_today',g.calls,'pacing_held',g.pacing,'model_cap_reached',g.capped)
 FROM judged g
$$;
COMMENT ON FUNCTION public.context_jobs_cadence(uuid[]) IS
 'K1: the one cadence judgement (cadence.md 5.1) for a set of jobs: due, blocked_reason, next_due_at and the facts behind them. Read by the claim, candidates, freshness and status.';

-- Jobs that can be due at all: some unread live row captured at or after live_since.
CREATE OR REPLACE FUNCTION public.context_cadence_pool() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_cadence_policy() AS p)
 SELECT DISTINCT u.job_id FROM public.context_unread_rows(NULL) u, pol
 WHERE u.context_captured_at>=(pol.p->>'live_since')::timestamptz
  AND coalesce(u.metadata->>'capture_mode','live')='live' AND u.metadata->>'written_as'='service_role'
$$;

-- 5. Due jobs, same signature: fewest runs today first, then oldest waking
-- evidence first.
CREATE OR REPLACE FUNCTION public.context_extraction_candidates(p_limit integer DEFAULT 400) RETURNS TABLE(job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH lane AS (SELECT public.automation_lane_enabled('extraction') AS enabled),
 judged AS (SELECT x.job_id, x.cadence AS c
  FROM public.context_jobs_cadence(ARRAY(SELECT p.job_id FROM public.context_cadence_pool() AS p(job_id) WHERE (SELECT enabled FROM lane))) x)
 SELECT j.job_id FROM judged j WHERE (j.c->>'due')::boolean
 ORDER BY (j.c->>'runs_today')::integer, (j.c->>'order_at')::timestamptz NULLS LAST, j.job_id
 LIMIT greatest(0,least(coalesce(p_limit,400),400))
$$;

-- 9. The cadence status block, read by the F1 composer.
CREATE OR REPLACE FUNCTION public.context_cadence_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_cadence_policy(); now_t timestamptz:=now(); today date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 lane boolean; attribution_lane boolean; calls integer; attribution_calls integer; judged jsonb; due_n integer; waiting_n integer;
 ceiling_n integer; pacing_n integer; oldest_unread timestamptz; oldest_wait numeric; breach boolean;
 runs integer; jobs_run integer; max_runs integer; takeovers integer; not_service integer; unplaced_n integer; oldest_unplaced timestamptz; alarms jsonb:='[]'::jsonb;
BEGIN
 lane:=public.automation_lane_enabled('extraction'); attribution_lane:=public.automation_lane_enabled('attribution');
 SELECT count(*), count(*) FILTER (WHERE phase='attribution') INTO calls, attribution_calls FROM public.context_model_call_reservations WHERE run_date=today;
 SELECT coalesce(jsonb_agg(x.cadence),'[]'::jsonb) INTO judged
  FROM public.context_jobs_cadence(ARRAY(SELECT p.job_id FROM public.context_cadence_pool() AS p(job_id))) x;
 SELECT count(*) FILTER (WHERE (c->>'due')::boolean),
  count(*) FILTER (WHERE NOT (c->>'due')::boolean AND (coalesce((c->>'waking_count')::integer,0)+coalesce((c->>'status_only_count')::integer,0))>0),
  count(*) FILTER (WHERE c->>'blocked_reason'='daily_ceiling'), count(*) FILTER (WHERE c->>'blocked_reason'='pacing_reserve'),
  min((c->>'order_at')::timestamptz),
  max(extract(epoch FROM now_t-(c->>'due_since')::timestamptz)/60) FILTER (WHERE (c->>'due')::boolean)
 INTO due_n, waiting_n, ceiling_n, pacing_n, oldest_unread, oldest_wait FROM jsonb_array_elements(judged) AS c;
 breach:=lane AND calls<(pol->>'model_call_cap')::integer AND coalesce(oldest_wait,0)>(pol->>'breach_wait_min')::integer;
 SELECT count(*), count(DISTINCT job_id), coalesce(max(n),0) INTO runs, jobs_run, max_runs
  FROM (SELECT job_id, count(*) OVER (PARTITION BY job_id) AS n FROM public.context_extraction_runs WHERE run_date=today AND phase='extraction') r;
 SELECT coalesce(sum(lease_takeovers),0) INTO takeovers FROM public.context_pass_days WHERE run_date=today;
 SELECT count(*) INTO not_service FROM public.business_events
  WHERE context_captured_at>now_t-interval '24 hours' AND metadata ? 'written_as' AND metadata->>'written_as'<>'service_role';
 SELECT count(*), min(coalesce(event_at,occurred_at)) INTO unplaced_n, oldest_unplaced FROM public.business_events WHERE attribution_status='unplaced';
 IF breach THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','cadence_breach','severity','warning',
   'since',now_t-make_interval(secs=>oldest_wait*60),'oldest_due_wait_minutes',round(oldest_wait),
   'what_to_do','A job has been due for a read for more than 90 minutes with the extraction lane on and model budget left. Check that the Luna context worker is running and ticking.'));
 END IF;
 RETURN jsonb_build_object('as_of',now_t,'policy',pol,
  'lanes',jsonb_build_object('extraction',lane,'attribution',attribution_lane),
  'due_jobs',due_n,'waiting_jobs',waiting_n,'oldest_unread_landed_at',oldest_unread,
  'oldest_due_wait_minutes',CASE WHEN oldest_wait IS NULL THEN NULL ELSE round(oldest_wait) END,'cadence_breach',breach,
  'runs_today',runs,'jobs_run_today',jobs_run,'max_runs_one_job_today',max_runs,
  'jobs_at_daily_ceiling',ceiling_n,'pacing_held_jobs',pacing_n,'lease_takeovers_today',takeovers,
  'model_calls_today',calls,'attribution_calls_today',attribution_calls,
  'unplaced_count',unplaced_n,'oldest_unplaced_at',oldest_unplaced,
  'rows_not_service_role_24h',not_service,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_cadence_status() IS
 'Status block cadence, owned by cadence slice K1 (cadence.md 9.A item 9). Due and waiting jobs from context_job_cadence, runs today, ceiling and pacing holds, lease takeovers, unplaced rows, rows not written as service_role, and the cadence_breach alarm.';

-- 4. The batch: newest customer (not ours) row always included, then live
-- waking rows (the same live non-status-only predicate as context_jobs_cadence)
-- ahead of landed time so the rows that woke the job are always read, older
-- rows while space remains; returned in time order. Exact rows (note a).
CREATE OR REPLACE FUNCTION public.context_extraction_events(p_job_id uuid,p_limit integer DEFAULT 25) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH admitted AS (
  SELECT public.automation_lane_enabled('extraction')
   AND EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=p_job_id AND public.context_job_extractable(j)) AS ok
 ), unread AS MATERIALIZED (
  SELECT u.* FROM public.context_unread_rows(ARRAY[p_job_id]) u WHERE (SELECT ok FROM admitted)
 ), anchor AS (
  SELECT e.id FROM unread u JOIN public.business_events e ON e.id=u.id
  WHERE NOT public.context_event_is_ours(e)
  ORDER BY greatest(e.context_captured_at,e.attributed_at) DESC NULLS LAST, e.id DESC LIMIT 1
 ), live_key AS (
  SELECT (pol.p->>'live_since')::timestamptz AS live_since, j.created_at
  FROM (SELECT public.context_cadence_policy() AS p) pol
  JOIN public.jobs j ON j.id=p_job_id
 ), picked AS (
  SELECT u.* FROM unread u CROSS JOIN live_key k
  ORDER BY (u.id IN (SELECT id FROM anchor)) DESC,
   (u.context_captured_at>=k.live_since AND coalesce(u.metadata->>'capture_mode','live')='live' AND u.metadata->>'written_as'='service_role'
    AND NOT (coalesce(u.attribution_step,0) IN (3,4) AND coalesce(u.event_at,u.occurred_at)<k.created_at)
    AND NOT public.context_event_status_only(u)) DESC,
   greatest(u.context_captured_at,u.attributed_at) DESC NULLS LAST, u.id DESC
  LIMIT greatest(0,least(coalesce(p_limit,25),25))
 ) SELECT * FROM picked ORDER BY coalesce(event_at,occurred_at), id
$$;

-- The flags the worker passes to the model and the validator for a batch:
-- ours (context_event_is_ours) and older_context (older than the age window,
-- or older than the job's last completed read). Ids not on the job are ignored.
CREATE OR REPLACE FUNCTION public.context_extraction_event_flags(p_job_id uuid,p_event_ids uuid[])
RETURNS TABLE(event_id uuid, ours boolean, older_context boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_cadence_policy() AS p),
 last_read AS (SELECT max(r.started_at) AS at FROM public.context_extraction_runs r
  WHERE r.job_id=p_job_id AND r.phase='extraction' AND r.status='done')
 SELECT e.id, public.context_event_is_ours(e),
  coalesce(coalesce(e.event_at,e.occurred_at)<now()-make_interval(days=>(pol.p->>'age_window_days')::integer)
   OR coalesce(e.event_at,e.occurred_at)<(SELECT at FROM last_read),false)
 FROM public.business_events e, pol
 WHERE p_job_id IS NOT NULL AND e.job_id=p_job_id AND e.id=ANY(coalesce(p_event_ids,'{}'::uuid[]))
 ORDER BY coalesce(e.event_at,e.occurred_at), e.id
$$;

DROP FUNCTION IF EXISTS public.context_catchup_pending_rows(uuid[]);

DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_jobs_cadence(uuid[])','71db787a8a80b5519b5a5c9b8d915d5c'),
  ('public.context_cadence_pool()','6943c7ed49e09cddc23a517255805fba'),
  ('public.context_extraction_candidates(integer)','0257dc0ea9c35a249b3b8adcb99a18d4'),
  ('public.context_cadence_status()','04a99b46fbdf6b6ac830602da6a92c3d'),
  ('public.context_extraction_events(uuid,integer)','b808f4b6fb24515a337c149a6353edf8'),
  ('public.context_extraction_event_flags(uuid,uuid[])','c384d748eca9b3b94ba6e54b26b781e5')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'catch-up rollback: % is not K1''s body (%)',x.sig,live; END IF;
 END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.context_jobs_cadence(uuid[]),public.context_cadence_pool(),public.context_extraction_candidates(integer),public.context_cadence_status(),
 public.context_extraction_events(uuid,integer),public.context_extraction_event_flags(uuid,uuid[])
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_jobs_cadence(uuid[]),public.context_cadence_pool(),public.context_extraction_candidates(integer),public.context_cadence_status(),
 public.context_extraction_events(uuid,integer),public.context_extraction_event_flags(uuid,uuid[])
TO service_role;
