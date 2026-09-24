-- One-time catch-up read of live jobs (captain, 24 Sep 2026).
--
-- K1 (20260924030000) reads a job only when evidence lands at or after
-- live_since, so evidence captured before go-live is never read again. This
-- migration gives each listed job one fresh full read through the normal K2
-- tick, caps and leases, without moving live_since:
--
--   context_catchup_jobs      the list: one row per job, priority 1 or 2,
--                             requested_at, done_at, done_run_id.
--   context_catchup_reads     which rows a catch-up read has covered, per
--                             job; recorded from the receipts a done run
--                             writes (a BEFORE INSERT trigger, so a row that
--                             already had a receipt is recorded too).
--   context_catchup_pending_rows  a listed, not-yet-done job's rows still to
--                             read: every readable, placed, worded row on the
--                             job that no catch-up read has covered, earlier
--                             receipts or not.
--   context_catchup_request   the one writer of the list (service role),
--                             chosen over a migration seed so the set is
--                             measured at the moment it runs: live jobs with
--                             readable evidence and no done read since
--                             live_since, priority 1 when something is
--                             unread. Dry run by default: counts by priority
--                             plus the job list, nothing written.
--   context_jobs_cadence      one added rule: a listed, not-yet-done job with
--                             pending rows is due from its request time,
--                             unless it has live waking evidence, which keeps
--                             K1's quiet and ceiling times. Cooldown, retry,
--                             the daily run limit, pacing (300 before 12:00)
--                             and the 400-call cap apply unchanged.
--   context_cadence_pool      listed, not-yet-done jobs join the pool.
--   context_extraction_candidates  live reads keep precedence over
--                             catch-up-only work; catch-up priority orders the
--                             catch-up-only work; a live read of a listed job
--                             also counts as its catch-up read. Same signature
--                             and cap.
--   context_extraction_events for a listed, not-yet-done job the batch is
--                             drawn from its pending rows instead of its unread
--                             rows; same 25-row batch, order and exact rows.
--   context_extraction_event_flags  a pending catch-up row is not flagged
--                             older_context, so the read is a fresh one.
--   context_catchup_mark_done a trigger on context_extraction_runs: a run that
--                             finishes done and leaves the job with no pending
--                             rows marks it done. A job with more rows than one
--                             batch takes further runs under the same caps.
--   context_cadence_status    a catchup block (requested, done, remaining,
--                             oldest requested), and a job due only by
--                             catch-up never raises cadence_breach (a backlog
--                             waiting its turn is not a stalled worker).
--
-- Unchanged: context_cadence_policy() (live_since included), the claim, the
-- finish, receipts, the tick lease, and every cap number.
-- Immediate stop needs no rollback: switch the extraction lane off, or mark the
-- remaining rows done. Rollback: supabase/rollbacks/20260924220000_context_catchup_jobs_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Each replaced function must be K1's body or this
-- migration's (re-apply). Read from production on 24 Sep 2026 (read-only): all
-- four cadence functions' live md5(prosrc) values equal K1's below,
-- context_catchup_jobs did not exist, and the newest ledger version at or
-- after 20260924200000 was 20260924201000. The batch and flags reads are
-- pinned to K1's bodies. Each new name must be absent or already this
-- migration's.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_jobs_cadence(uuid[])',ARRAY['71db787a8a80b5519b5a5c9b8d915d5c','184bfbf98717e2a85cfaed282bcca9a6'],false),
  ('public.context_cadence_pool()',ARRAY['6943c7ed49e09cddc23a517255805fba','5cb50d8d47eb917acb2406ae3f0d9369'],false),
  ('public.context_extraction_candidates(integer)',ARRAY['0257dc0ea9c35a249b3b8adcb99a18d4','fc0f681d15d59c80a8ee41b45d0486cc'],false),
  ('public.context_cadence_status()',ARRAY['04a99b46fbdf6b6ac830602da6a92c3d','552d7971757d43624ec3667e3dc1fb99'],false),
  ('public.context_extraction_events(uuid,integer)',ARRAY['b808f4b6fb24515a337c149a6353edf8','68f6da2aac47cae91aa62a0420402d74'],false),
  ('public.context_extraction_event_flags(uuid,uuid[])',ARRAY['c384d748eca9b3b94ba6e54b26b781e5','5aedb3e5a7aa3286145079032e8e22f8'],false),
  ('public.context_catchup_request(boolean)',ARRAY['00e528957da6f35f40b478db61dddaca','0c2ee37eb1cf37ee854210cc1d71871a'],true),
  ('public.context_catchup_pending_rows(uuid[])',ARRAY['a0e09f635eff10a48fa51b40aef5bafd'],true),
  ('public.context_catchup_record_read()',ARRAY['5420a6486bee3e03501200008aca6053'],true),
  ('public.context_catchup_mark_done()',ARRAY['f52e823ab347b0983bb561bcb951514d'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regclass('public.context_catchup_jobs') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_description d
   WHERE d.objoid=to_regclass('public.context_catchup_jobs') AND d.classoid='pg_class'::regclass AND d.objsubid=0 AND d.description LIKE 'Catch-up:%')
 THEN problems:=problems||'public.context_catchup_jobs already exists and is not this migration''s'::text; END IF;
 IF to_regclass('public.context_catchup_reads') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_description d
   WHERE d.objoid=to_regclass('public.context_catchup_reads') AND d.classoid='pg_class'::regclass AND d.objsubid=0 AND d.description LIKE 'Catch-up:%')
 THEN problems:=problems||'public.context_catchup_reads already exists and is not this migration''s'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_catchup_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The list.
CREATE TABLE IF NOT EXISTS public.context_catchup_jobs (
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
 job_number text NOT NULL,
 priority smallint NOT NULL CHECK (priority IN (1,2)),
 requested_at timestamptz NOT NULL DEFAULT now(),
 done_at timestamptz,
 done_run_id uuid,
 CHECK ((done_at IS NULL)=(done_run_id IS NULL))
);
COMMENT ON TABLE public.context_catchup_jobs IS
 'Catch-up: jobs to give one fresh full read regardless of live_since (20260924220000). Written by context_catchup_request; done_at is set by the first done extraction run that leaves the job with no pending rows. Service role only.';
ALTER TABLE public.context_catchup_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_catchup_jobs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.context_catchup_jobs TO service_role;

CREATE TABLE IF NOT EXISTS public.context_catchup_reads (
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 event_id uuid NOT NULL REFERENCES public.business_events(id) ON DELETE CASCADE,
 run_id uuid NOT NULL,
 read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (job_id,event_id)
);
COMMENT ON TABLE public.context_catchup_reads IS
 'Catch-up: rows a catch-up read has covered, per job (20260924220000). Written only by the context_catchup_record_read trigger on context_extraction_event_receipts. Service role only.';
ALTER TABLE public.context_catchup_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_catchup_reads FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.context_catchup_reads TO service_role;

-- The rows a listed, not-yet-done job still has to read: the unread
-- definition (context_unread_rows) without its receipt clause, with the
-- catch-up read record in its place.
CREATE OR REPLACE FUNCTION public.context_catchup_pending_rows(p_job_ids uuid[]) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.* FROM public.business_events e
 JOIN public.context_catchup_jobs c ON c.job_id=e.job_id AND c.done_at IS NULL
 WHERE e.job_id=ANY(p_job_ids)
  AND public.context_linked_status(e.attribution_status)
  AND e.context_captured_at IS NOT NULL
  AND coalesce(e.metadata->>'written_as','service_role')='service_role'
  AND btrim(public.context_event_text(e))<>''
  AND NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=e.job_id AND r.event_id=e.id)
$$;
COMMENT ON FUNCTION public.context_catchup_pending_rows(uuid[]) IS
 'Catch-up: rows on listed, not-yet-done jobs that no catch-up read has covered, earlier receipts or not. Service role only.';

-- A done run's receipts record the rows it read. BEFORE INSERT, so a row whose
-- receipt already exists (ON CONFLICT DO NOTHING in the finish) is recorded too.
CREATE OR REPLACE FUNCTION public.context_catchup_record_read() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.context_catchup_jobs c WHERE c.job_id=NEW.job_id AND c.done_at IS NULL) THEN
  INSERT INTO public.context_catchup_reads(job_id,event_id,run_id) VALUES(NEW.job_id,NEW.event_id,NEW.run_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS context_catchup_record_read ON public.context_extraction_event_receipts;
CREATE TRIGGER context_catchup_record_read BEFORE INSERT ON public.context_extraction_event_receipts
 FOR EACH ROW EXECUTE FUNCTION public.context_catchup_record_read();

-- 2. The writer. The list is defined by rule, never by a typed job list:
--   live      status accepted, scheduled or in_progress (make-safe included),
--             or quoted with quoted_at within the last 60 days; not a holding
--             job (context_job_extractable);
--   evidence  at least one readable, placed, worded business_events row on
--             the job;
--   stale     no extraction run finished done at or after live_since.
-- Priority 1: something still unread (context_unread_rows, the one unread
-- definition). Priority 2: the rest.
-- p_dry_run (default true) returns the counts and the job list without
-- writing. A real run adds new jobs, raises a pending job from 2 to 1 when it
-- now has unread evidence, never lowers a priority, and leaves done jobs done
-- (the catch-up is one-time).
CREATE OR REPLACE FUNCTION public.context_catchup_request(p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE live_from timestamptz:=(public.context_cadence_policy()->>'live_since')::timestamptz; picked jsonb; excluded jsonb;
 added integer:=0; raised integer:=0; kept integer:=0; done integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(20260924,22);
 WITH live AS (
  SELECT j.id, j.job_number, public.context_job_extractable(j) AS extractable
  FROM public.jobs j
  WHERE j.status IN ('accepted','scheduled','in_progress') OR (j.status='quoted' AND j.quoted_at>=now()-interval '60 days')
 ), facts AS (
  SELECT l.*,
   EXISTS(SELECT 1 FROM public.business_events e WHERE e.job_id=l.id AND public.context_linked_status(e.attribution_status)
    AND e.context_captured_at IS NOT NULL
    AND coalesce(e.metadata->>'written_as','service_role')='service_role'
    AND btrim(public.context_event_text(e))<>'') AS has_evidence,
   (SELECT max(r.finished_at) FROM public.context_extraction_runs r WHERE r.job_id=l.id AND r.phase='extraction' AND r.status='done') AS last_read,
   EXISTS(SELECT 1 FROM public.context_unread_rows(ARRAY[l.id])) AS has_unread
  FROM live l
 ), judged AS (
  SELECT f.*, CASE WHEN f.has_unread THEN 1 ELSE 2 END AS priority,
   f.extractable AND f.has_evidence AND (f.last_read IS NULL OR f.last_read<live_from) AS pick
  FROM facts f
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('job_id',g.id,'job_number',g.job_number,'priority',g.priority,'last_read_at',g.last_read)
   ORDER BY g.priority,g.job_number) FILTER (WHERE g.pick),'[]'::jsonb),
  jsonb_build_object('live_jobs',count(*),'holding_job',count(*) FILTER (WHERE NOT g.extractable),
   'no_evidence',count(*) FILTER (WHERE g.extractable AND NOT g.has_evidence),
   'read_since_live',count(*) FILTER (WHERE g.extractable AND g.has_evidence AND g.last_read>=live_from))
 INTO picked, excluded FROM judged g;
 IF NOT coalesce(p_dry_run,true) THEN
  WITH src AS (SELECT (x->>'job_id')::uuid AS job_id, x->>'job_number' AS job_number, (x->>'priority')::smallint AS priority
   FROM jsonb_array_elements(picked) x),
  cur AS (SELECT s.*, c.job_id IS NOT NULL AS listed, c.done_at IS NOT NULL AS was_done, c.priority AS old_priority
   FROM src s LEFT JOIN public.context_catchup_jobs c ON c.job_id=s.job_id),
  ins AS (INSERT INTO public.context_catchup_jobs(job_id,job_number,priority) SELECT job_id,job_number,priority FROM cur WHERE NOT listed
   ON CONFLICT (job_id) DO NOTHING RETURNING job_id),
  upd AS (UPDATE public.context_catchup_jobs c SET priority=cur.priority FROM cur
   WHERE c.job_id=cur.job_id AND cur.listed AND NOT cur.was_done AND cur.priority<cur.old_priority RETURNING c.job_id)
  SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM upd),
   count(*) FILTER (WHERE listed AND NOT was_done)-(SELECT count(*) FROM upd), count(*) FILTER (WHERE was_done)
  INTO added, raised, kept, done FROM cur;
 END IF;
 RETURN jsonb_build_object('dry_run',coalesce(p_dry_run,true),'as_of',now(),'live_since',live_from,
  'candidates',jsonb_array_length(picked),
  'by_priority',jsonb_build_object('1',(SELECT count(*) FROM jsonb_array_elements(picked) x WHERE (x->>'priority')::int=1),
   '2',(SELECT count(*) FROM jsonb_array_elements(picked) x WHERE (x->>'priority')::int=2)),
  'excluded',excluded,'jobs',picked,
  'written',CASE WHEN coalesce(p_dry_run,true) THEN NULL ELSE jsonb_build_object('added',added,'priority_raised',raised,'already_listed',kept,'already_done',done) END);
END $$;
COMMENT ON FUNCTION public.context_catchup_request(boolean) IS
 'Catch-up: pick live jobs with readable evidence and no done extraction run since live_since; priority 1 when something is unread, else 2. Dry run (the default) returns counts by priority plus the job list without writing; false writes the list. Service role only.';

-- 3. Done marker: a run that finishes done and leaves the job with nothing
-- pending. Its receipts (and so its catch-up reads) are written before the
-- run's status changes, inside the same finish call.
CREATE OR REPLACE FUNCTION public.context_catchup_mark_done() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.phase='extraction' AND NEW.status='done' AND NEW.job_id IS NOT NULL
  AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'done') THEN
  UPDATE public.context_catchup_jobs SET done_at=now(),done_run_id=NEW.id WHERE job_id=NEW.job_id AND done_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.context_catchup_pending_rows(ARRAY[NEW.job_id]));
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS context_catchup_mark_done ON public.context_extraction_runs;
CREATE TRIGGER context_catchup_mark_done AFTER INSERT OR UPDATE OF status ON public.context_extraction_runs
 FOR EACH ROW EXECUTE FUNCTION public.context_catchup_mark_done();

-- 4. The cadence judgement: K1's body plus the catch-up rule (marked "catch-up").
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

-- 5. The pool: K1's live_since pool plus listed jobs not yet done.
CREATE OR REPLACE FUNCTION public.context_cadence_pool() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_cadence_policy() AS p)
 SELECT u.job_id FROM public.context_unread_rows(NULL) u, pol
 WHERE u.context_captured_at>=(pol.p->>'live_since')::timestamptz
  AND coalesce(u.metadata->>'capture_mode','live')='live' AND u.metadata->>'written_as'='service_role'
 UNION
 SELECT c.job_id FROM public.context_catchup_jobs c WHERE c.done_at IS NULL
$$;

-- 6. Live reads keep precedence over catch-up-only work. Catch-up priority
-- orders the catch-up-only work; a live read of a listed job also counts as
-- its catch-up read.
CREATE OR REPLACE FUNCTION public.context_extraction_candidates(p_limit integer DEFAULT 400) RETURNS TABLE(job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH lane AS (SELECT public.automation_lane_enabled('extraction') AS enabled),
 judged AS (SELECT x.job_id, x.cadence AS c
  FROM public.context_jobs_cadence(ARRAY(SELECT p.job_id FROM public.context_cadence_pool() AS p(job_id) WHERE (SELECT enabled FROM lane))) x)
 SELECT j.job_id FROM judged j WHERE (j.c->>'due')::boolean
 ORDER BY CASE WHEN (j.c->>'catchup_only')::boolean THEN (j.c->>'catchup_priority')::integer ELSE 0 END,
  (j.c->>'runs_today')::integer, (j.c->>'order_at')::timestamptz NULLS LAST, (j.c->>'oldest_unread_landed_at')::timestamptz NULLS LAST, j.job_id
 LIMIT greatest(0,least(coalesce(p_limit,400),400))
$$;

-- 6a. The batch: K1's read, with a listed, not-yet-done job's rows drawn from
-- its pending catch-up rows (earlier receipts or not) instead of its unread
-- rows. Same order, same 25-row cap, exact business_events rows.
CREATE OR REPLACE FUNCTION public.context_extraction_events(p_job_id uuid,p_limit integer DEFAULT 25) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH admitted AS (
  SELECT public.automation_lane_enabled('extraction')
   AND EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=p_job_id AND public.context_job_extractable(j)) AS ok,
   EXISTS(SELECT 1 FROM public.context_catchup_jobs c WHERE c.job_id=p_job_id AND c.done_at IS NULL) AS catchup
 ), unread AS MATERIALIZED (
  SELECT u.* FROM public.context_unread_rows(ARRAY[p_job_id]) u WHERE (SELECT ok AND NOT catchup FROM admitted)
  UNION ALL
  -- catch-up: the job's pending rows.
  SELECT c.* FROM public.context_catchup_pending_rows(ARRAY[p_job_id]) c WHERE (SELECT ok AND catchup FROM admitted)
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

-- 6b. Flags: K1's, except that a pending catch-up row is never older_context
-- (the catch-up is a fresh read of rows read before go-live).
CREATE OR REPLACE FUNCTION public.context_extraction_event_flags(p_job_id uuid,p_event_ids uuid[])
RETURNS TABLE(event_id uuid, ours boolean, older_context boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_cadence_policy() AS p),
 last_read AS (SELECT max(r.started_at) AS at FROM public.context_extraction_runs r
  WHERE r.job_id=p_job_id AND r.phase='extraction' AND r.status='done'),
 pending AS (SELECT c.id FROM public.context_catchup_pending_rows(ARRAY[p_job_id]) c)
 SELECT e.id, public.context_event_is_ours(e),
  coalesce(e.id NOT IN (SELECT id FROM pending) AND (coalesce(e.event_at,e.occurred_at)<now()-make_interval(days=>(pol.p->>'age_window_days')::integer)
   OR coalesce(e.event_at,e.occurred_at)<(SELECT at FROM last_read)),false)
 FROM public.business_events e, pol
 WHERE p_job_id IS NOT NULL AND e.job_id=p_job_id AND e.id=ANY(coalesce(p_event_ids,'{}'::uuid[]))
 ORDER BY coalesce(e.event_at,e.occurred_at), e.id
$$;

-- 7. The cadence status block: K1's block plus catchup; a job due only by
-- catch-up does not count towards cadence_breach.
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

-- 8. Grants: service role only.
REVOKE ALL ON FUNCTION public.context_catchup_request(boolean),public.context_catchup_mark_done(),public.context_catchup_record_read(),
 public.context_catchup_pending_rows(uuid[]),public.context_extraction_events(uuid,integer),public.context_extraction_event_flags(uuid,uuid[]),
 public.context_jobs_cadence(uuid[]),public.context_cadence_pool(),public.context_extraction_candidates(integer),public.context_cadence_status()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_catchup_request(boolean),
 public.context_catchup_pending_rows(uuid[]),public.context_extraction_events(uuid,integer),public.context_extraction_event_flags(uuid,uuid[]),
 public.context_jobs_cadence(uuid[]),public.context_cadence_pool(),public.context_extraction_candidates(integer),public.context_cadence_status()
TO service_role;
