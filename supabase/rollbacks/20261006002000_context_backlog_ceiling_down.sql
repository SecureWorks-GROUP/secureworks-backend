-- Down migration for 20261006002000_context_backlog_ceiling.
--
-- Restores context_jobs_cadence and context_cadence_status to
-- 20260924220000's repository bodies and claim_context_extraction_run to K1's
-- (20260924030000), each md5 checked at the end, and drops
-- context_cadence_settings. Catch-up and backlog jobs then share the day's
-- calls with live reads again. No list row, run, receipt or reservation is
-- touched. Refuses when a replaced function is neither this migration's body
-- nor the restored one (a later migration owns it now: roll that back first).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_jobs_cadence(uuid[])',ARRAY['c711479690d167f09d016f0413f11160','184bfbf98717e2a85cfaed282bcca9a6']),
  ('public.context_cadence_status()',ARRAY['85e60d754e65b812b28e798435e2a5a4','552d7971757d43624ec3667e3dc1fb99']),
  ('public.claim_context_extraction_run(uuid,date,text)',ARRAY['0e31f4c0017a05a004e420907f8bc73a','ac6f021c77dbf0e44a949ea94d24f666'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_backlog_ceiling_rollback_mismatch: %; a later migration replaced these, roll it back first',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 20260924220000's cadence judgement.
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
  'model_calls_today',g.calls,'pacing_held',g.pacing,'model_cap_reached',g.capped,
  -- catch-up: catchup_only is true when the catch-up rule, not live evidence, sets the due time.
  'catchup_priority',g.catchup_priority,'catchup_only',(g.catchup_priority IS NOT NULL AND g.wake_n=0),'catchup_pending_count',g.catchup_pending_n)
 FROM judged g
$$;
COMMENT ON FUNCTION public.context_jobs_cadence(uuid[]) IS
 'K1: the one cadence judgement (cadence.md 5.1) for a set of jobs: due, blocked_reason, next_due_at and the facts behind them. Read by the claim, candidates, freshness and status. Catch-up (20260924220000): a listed, not-yet-done job with pending rows is due from its request time.';

-- K1's claim (20260924030000).
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

-- 20260924220000's status block.
CREATE OR REPLACE FUNCTION public.context_cadence_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_cadence_policy(); now_t timestamptz:=now(); today date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 lane boolean; attribution_lane boolean; calls integer; attribution_calls integer; judged jsonb; due_n integer; waiting_n integer;
 ceiling_n integer; pacing_n integer; oldest_unread timestamptz; oldest_wait numeric; breach boolean;
 runs integer; jobs_run integer; max_runs integer; takeovers integer; not_service integer; unplaced_n integer; oldest_unplaced timestamptz; alarms jsonb:='[]'::jsonb;
 catchup jsonb;
BEGIN
 lane:=public.automation_lane_enabled('extraction'); attribution_lane:=public.automation_lane_enabled('attribution');
 SELECT count(*), count(*) FILTER (WHERE phase='attribution') INTO calls, attribution_calls FROM public.context_model_call_reservations WHERE run_date=today;
 SELECT coalesce(jsonb_agg(x.cadence),'[]'::jsonb) INTO judged
  FROM public.context_jobs_cadence(ARRAY(SELECT p.job_id FROM public.context_cadence_pool() AS p(job_id))) x;
 SELECT count(*) FILTER (WHERE (c->>'due')::boolean),
  count(*) FILTER (WHERE NOT (c->>'due')::boolean AND (coalesce((c->>'waking_count')::integer,0)+coalesce((c->>'status_only_count')::integer,0))>0),
  count(*) FILTER (WHERE c->>'blocked_reason'='daily_ceiling'), count(*) FILTER (WHERE c->>'blocked_reason'='pacing_reserve'),
  min((c->>'order_at')::timestamptz),
  max(extract(epoch FROM now_t-(c->>'due_since')::timestamptz)/60) FILTER (WHERE (c->>'due')::boolean AND NOT coalesce((c->>'catchup_only')::boolean,false))
 INTO due_n, waiting_n, ceiling_n, pacing_n, oldest_unread, oldest_wait FROM jsonb_array_elements(judged) AS c;
 breach:=lane AND calls<(pol->>'model_call_cap')::integer AND coalesce(oldest_wait,0)>(pol->>'breach_wait_min')::integer;
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
  'rows_not_service_role_24h',not_service,'catchup',catchup,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_cadence_status() IS
 'Status block cadence, owned by cadence slice K1 (cadence.md 9.A item 9). Due and waiting jobs from context_job_cadence, runs today, ceiling and pacing holds, lease takeovers, unplaced rows, rows not written as service_role, the cadence_breach alarm (jobs due only by catch-up excluded), and the catch-up progress block (20260924220000).';

REVOKE ALL ON FUNCTION public.context_jobs_cadence(uuid[]),public.context_cadence_status(),public.claim_context_extraction_run(uuid,date,text)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_jobs_cadence(uuid[]),public.context_cadence_status(),public.claim_context_extraction_run(uuid,date,text)
TO service_role;

DROP TABLE IF EXISTS public.context_cadence_settings;

DO $$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_jobs_cadence(uuid[])','184bfbf98717e2a85cfaed282bcca9a6'),
  ('public.context_cadence_status()','552d7971757d43624ec3667e3dc1fb99'),
  ('public.claim_context_extraction_run(uuid,date,text)','ac6f021c77dbf0e44a949ea94d24f666')
 ) AS t(sig,want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.want THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'context_backlog_ceiling rollback: bodies not restored: %',array_to_string(problems,'; '); END IF;
END $$;
