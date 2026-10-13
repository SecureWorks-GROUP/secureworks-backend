-- Rebuild request (13 Oct 2026): an operator can ask for one job's notes to be read again whole, once.
--
-- The owner's ask (Marnin, 13 Oct 2026): "Build the rebuild-request. Keep it small: a reason an
-- operator can set on a job that makes the reader treat it as due once, used through an existing
-- guarded path, no new screen."
--
-- Why. The judge (context_ledger_judge) finds a job due a whole re-read for four reasons, each read
-- from the data: its reading failed its checks, a citation moved, the reader's name changed, or late
-- evidence landed. The claim answers not_due for anything else. So when a reader is fixed without a
-- change of name, the jobs it read before the fix keep what it wrote and nothing marks them due:
-- nine jobs read by luna-ledger:v3 before its 13 Oct fix still show internal row labels in their
-- live notes, and there is no supported way to have them read again.
--
-- What it does:
--  1. context_ledger_rebuild_requests: one row per ask (the job, who asked, why, when). Nothing else
--     is ever written to it; whether a request is answered is read from the readings, like every
--     other reason the judge has.
--  2. context_ledger_rebuild_request_state(job ids): the one rule for where a request stands:
--     * read: a whole reading of the job (a backfill or a rebuild) claimed after the request
--       passes its checks as a shadow, or went live. It names that reading and when.
--     * gave_up: not read, and three whole readings claimed after the request failed (a failed
--       read, a lost lease, or one that failed its checks or was held as thin). A read stopped for
--       budget, a pause, a rate limit or a sign-in (released) is not a failure and never counts.
--     * pending: neither yet.
--  3. context_ledger_request_rebuild(job, who, why): the operator's door. It files a request and
--     answers with what the judge says of the job at that moment, so a block is seen at once. A job
--     with a pending request is not given a second one (already_requested).
--  4. context_ledger_judge: a job with a pending request is due kind rebuild, reason
--     rebuild_requested, priority 3 with the reader-change rebuilds. Only where the judgement has no
--     reason of its own: a job never read, any other rebuild and a new-message update keep their own
--     reason and are read first, and a whole reading made for any of them answers the request too.
--     Every block holds it as it holds any rebuild: the lane or ledger off, not in the rollout, not
--     live, a holding job, a lead no longer followed up, no evidence, busy, needs a person, the
--     backoff of failed reads, and outside the backfill hours.
--
-- Once, and never a loop. The request is answered by the reading it caused, so the judge stops
-- naming it the moment that reading passes. A reading that fails leaves it pending: the job waits
-- out the store's usual backoff (2 hours, 8 hours, the next Perth day) and is due again, three times
-- at most. A reading held as thin (20261012110000) is one of the three; the second read settles it
-- as that guard always does. Nothing is written when a request is answered or given up, so no path
-- that puts a reading live (finish, the go-live sweep, a person) can miss it.
--
-- What it does not do. With no request on file every job is judged exactly as before: the judge
-- reads an empty table and adds nothing. The claim, finish, the due list, the budgets, the backfill
-- hours, the reader and the worker are not changed: the claim already takes any rebuild the judge
-- calls due, and the worker (secureworks-jarvis, luna-ledger-phase.ts) passes the reason through
-- and checks only the kind. In the due list a requested rebuild sits in priority 3 behind the
-- reader-change rebuilds of jobs whose customer has written (20261012164500), in the order
-- priority 3 had before that slice. No request is filed by this migration.
--
-- Read only on production (13 Oct 2026, about 15:00 Perth): context_ledger_judge is the
-- 20261012093500 body (md5 902eaf18e7fd84e05d0db5ffa6e67de1), context_ledger_due the 20261012164500
-- body (874180d1d58ffc8a35cbe167b9f33d6d), context_ledger_claim the 20261006013000 body
-- (5450d6ebcf78f29a3d8723d2248f0bdd) and context_ledger_finish the 20261012110000 body
-- (1695e52f99f56534a24166f6662ced35), each the same as this repository's. Ledger mode live, reader
-- luna-ledger:v3, no backfill hours set; 562 live readings, 558 by the current reader; the due list
-- held one update. Neither the table nor the two new functions exist.
--
-- Replaced body (guarded on its live production md5, or this migration's own for a re-apply):
--  context_ledger_judge, the 20261012093500 body word for word with one CTE (rq), one WHEN of the
--  reason, one join and one WHEN of the priority added, each marked "rebuild request", and its
--  comment (the earlier slices' names first).
-- Added: the table context_ledger_rebuild_requests and the functions
--  context_ledger_rebuild_request_state and context_ledger_request_rebuild. Service role only.
-- Rollback: supabase/rollbacks/20261013153000_context_rebuild_request_down.sql (the 20261012093500
--  judge and comment word for word; the two functions and the table dropped, with any request filed).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. The judge replaced here must be the one production and main have before this migration
-- (md5 of prosrc, read 13 Oct 2026) or this migration's own; anything else is someone else's change
-- and is refused, never overwritten. What the new bodies read must exist, and the new names must be
-- free or this migration's own.
DO $guard$
DECLARE problems text[] := '{}'; live text; f text; t text; x record;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_judge(uuid[])');
 IF live IS NULL OR NOT live = ANY (ARRAY['902eaf18e7fd84e05d0db5ffa6e67de1', '92367db74677cd38612394056aac07fa']) THEN
  problems := problems || format('public.context_ledger_judge(uuid[]) md5 %s', coalesce(live, '<missing>'));
 END IF;
 -- Read, never replaced.
 FOREACH f IN ARRAY ARRAY['public.context_ledger_checks_pass(jsonb)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['context_ledger_generations.job_id', 'context_ledger_generations.status', 'context_ledger_generations.checks',
   'context_ledger_generations.failure', 'context_ledger_generations.created_at', 'context_ledger_generations.finished_at',
   'context_ledger_generations.promoted_at', 'jobs.id'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 -- New objects: absent, or this migration's (comment marker).
 IF to_regclass('public.context_ledger_rebuild_requests') IS NOT NULL
    AND coalesce(obj_description(to_regclass('public.context_ledger_rebuild_requests'), 'pg_class'), '') NOT LIKE 'Rebuild request (20261013153000)%' THEN
  problems := problems || 'public.context_ledger_rebuild_requests exists and is not this migration''s'::text;
 END IF;
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('context_ledger_rebuild_request_state', 'context_ledger_request_rebuild') LOOP
  IF x.c NOT LIKE 'Rebuild request (20261013153000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_rebuild_request_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The requests. One row per ask, never updated: where a request stands is read from the readings
-- (section 2). Service role only, and written only by context_ledger_request_rebuild.
CREATE TABLE IF NOT EXISTS public.context_ledger_rebuild_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 120),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 600),
 requested_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.context_ledger_rebuild_requests IS
 'Rebuild request (20261013153000): an operator''s ask to have one job''s notes read again whole, once: the job, who asked, why and when. A row is never updated: whether it is pending, read or given up is read from the job''s readings by context_ledger_rebuild_request_state, which the ledger judge reads. Service role only; written only by context_ledger_request_rebuild.';
CREATE INDEX IF NOT EXISTS context_ledger_rebuild_requests_job
 ON public.context_ledger_rebuild_requests (job_id, requested_at);
ALTER TABLE public.context_ledger_rebuild_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_ledger_rebuild_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_ledger_rebuild_requests TO service_role;

-- 2. Where each request stands: the one rule, read by the judge and by whoever asked.
CREATE OR REPLACE FUNCTION public.context_ledger_rebuild_request_state(p_job_ids uuid[] DEFAULT NULL)
RETURNS TABLE(request_id uuid, job_id uuid, requested_by text, reason text, requested_at timestamptz, state text, failed_reads integer,
 read_generation_id uuid, read_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT q.id, q.job_id, q.requested_by, q.reason, q.requested_at,
  CASE WHEN a.id IS NOT NULL THEN 'read' WHEN f.n >= 3 THEN 'gave_up' ELSE 'pending' END,
  f.n, a.id, a.at
 FROM public.context_ledger_rebuild_requests q
 -- the reading that answers it: the first whole reading claimed after the request that went
 -- live (promoted_at is kept when a later reading retires it) or is a shadow passing its checks
 LEFT JOIN LATERAL (
  SELECT g.id, coalesce(g.promoted_at, g.finished_at, g.created_at) AS at
  FROM public.context_ledger_generations g
  WHERE g.job_id = q.job_id AND g.created_at > q.requested_at
   AND (g.promoted_at IS NOT NULL OR (g.status = 'shadow' AND public.context_ledger_checks_pass(g.checks)))
  ORDER BY g.created_at, g.id LIMIT 1) a ON true
 -- the whole readings claimed after it that failed: a failed build (never a released stop),
 -- or a shadow that failed its checks or is held as thin and was never put live. Three give it up
 CROSS JOIN LATERAL (
  SELECT count(*)::integer AS n
  FROM public.context_ledger_generations g
  WHERE g.job_id = q.job_id AND g.created_at > q.requested_at
   AND ((g.status = 'failed' AND coalesce(g.failure, '') NOT LIKE 'released:%')
        OR (g.status = 'shadow' AND g.promoted_at IS NULL AND NOT public.context_ledger_checks_pass(g.checks)))) f
 WHERE p_job_ids IS NULL OR q.job_id = ANY(p_job_ids)
 ORDER BY q.requested_at, q.id
$$;
COMMENT ON FUNCTION public.context_ledger_rebuild_request_state(uuid[]) IS
 'Rebuild request (20261013153000): where each rebuild request stands (context_ledger_rebuild_requests), for the given jobs or every job when null, oldest first: state read (a whole reading of the job, a backfill or a rebuild, claimed after the request went live or is a shadow passing its checks: read_generation_id and read_at name the first such), gave_up (not read, and three whole readings claimed after it failed: a failed build, a lost lease, or a shadow that failed its checks or is held as thin; a released stop never counts), else pending. failed_reads is that count. Nothing is stored: the state is read from the job''s readings each time. The ledger judge calls a job with a pending request due a rebuild (reason rebuild_requested). Service role only.';

-- 3. The operator's door: file a request, and say what the judge makes of the job now.
CREATE OR REPLACE FUNCTION public.context_ledger_request_rebuild(p_job_id uuid, p_requested_by text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_by text := btrim(coalesce(p_requested_by, '')); v_reason text := btrim(coalesce(p_reason, ''));
 q record; d record; v_id uuid; v_at timestamptz;
BEGIN
 IF p_job_id IS NULL OR length(v_by) NOT BETWEEN 1 AND 120 OR length(v_reason) NOT BETWEEN 1 AND 600 THEN
  RAISE EXCEPTION 'context_ledger_request_rebuild_invalid';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_job');
 END IF;
 -- One request at a time per job.
 PERFORM pg_advisory_xact_lock(20261013, hashtext(p_job_id::text));
 SELECT s.request_id, s.requested_at, s.failed_reads INTO q FROM public.context_ledger_rebuild_request_state(ARRAY[p_job_id]) s
 WHERE s.state = 'pending' ORDER BY s.requested_at, s.request_id LIMIT 1;
 IF q.request_id IS NULL THEN
  INSERT INTO public.context_ledger_rebuild_requests (job_id, requested_by, reason) VALUES (p_job_id, v_by, v_reason)
  RETURNING id, requested_at INTO v_id, v_at;
 END IF;
 -- What the judge says of the job now: due (and for what), or what holds it.
 SELECT * INTO d FROM public.context_ledger_judge(ARRAY[p_job_id]);
 RETURN jsonb_build_object('outcome', CASE WHEN q.request_id IS NULL THEN 'requested' ELSE 'already_requested' END,
  'request_id', coalesce(q.request_id, v_id), 'requested_at', coalesce(q.requested_at, v_at),
  'failed_reads', coalesce(q.failed_reads, 0), 'due', d.due, 'kind', d.kind, 'due_reason', d.reason,
  'blocked_reason', d.blocked_reason);
END $$;
COMMENT ON FUNCTION public.context_ledger_request_rebuild(uuid, text, text) IS
 'Rebuild request (20261013153000): an operator asks for one job''s notes to be read again whole, once. Files a row in context_ledger_rebuild_requests (the job, who asked: 1 to 120 characters, why: 1 to 600) and answers outcome requested with request_id, requested_at and what the ledger judge says of the job at that moment (due, kind, due_reason, blocked_reason), so a block is seen at once. A job with a pending request is not given a second: already_requested, with the pending one. A job that does not exist: refused, unknown_job. Missing or over-long arguments raise context_ledger_request_rebuild_invalid. The request makes the job due a rebuild (reason rebuild_requested) by the judge''s rules and blocks; context_ledger_rebuild_request_state says when it has been read. Requests serialise per job (an advisory lock). Service role only.';

-- 4. The judge: a job with a pending request is due a rebuild where it had no reason of its own
-- (20261012093500's body otherwise).
CREATE OR REPLACE FUNCTION public.context_ledger_judge(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, due boolean, kind text, reason text, priority integer, newest_evidence_at timestamptz,
 evidence_rows integer, generation_id uuid, blocked_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH s AS (
  SELECT coalesce((SELECT st.mode FROM public.context_ledger_settings st WHERE st.id), 'off') AS mode,
   (SELECT st.reader FROM public.context_ledger_settings st WHERE st.id) AS reader,
   (SELECT st.job_ids FROM public.context_ledger_settings st WHERE st.id) AS job_ids,
   public.automation_lane_enabled('extraction') AS lane,
   public.context_ledger_backfill_open((SELECT st.backfill_from_hour FROM public.context_ledger_settings st WHERE st.id),
    (SELECT st.backfill_to_hour FROM public.context_ledger_settings st WHERE st.id), now()) AS window_open
 ), j0 AS (
  SELECT jb.id, jb.status::text AS status,
   jb.status::text NOT IN ('cancelled','archived','complete','completed','lost') AS open_job,
   coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1') AS schedulable
  FROM public.jobs jb WHERE jb.id = ANY(p_job_ids)
 ), lr AS MATERIALIZED (
  -- (scoping pipeline, 20261009133000) the lead rule's row as of now, read once, for every job asked
  -- about, a draft among them (context_lead_monitored_jobs); (finished wake, 20261012093500) and a
  -- finished job, whose state says whether its customer has written inside the wake window
  SELECT m.job_id, m.monitored, m.state FROM public.context_lead_monitored_jobs(ARRAY(SELECT j0.id FROM j0), now()) m
 ), j AS (
  -- (scoping pipeline, 20261009133000) a draft is live only while the rule monitors it (real activity
  -- on it inside its window: 4 weeks, 6 on a patio job); one it does not is not_live, as every draft was.
  -- (Finished wake, 20261012093500) A finished job (cancelled, archived, complete, completed or lost)
  -- is live only while the rule calls it awake (state finished_awake: a real inbound message of its
  -- customer's on it inside 30 days); a quiet one is not_live, as every finished job was
  SELECT j0.id, (j0.open_job AND (j0.status <> 'draft' OR coalesce(lr.monitored, false)))
                OR (NOT j0.open_job AND coalesce(lr.state = 'finished_awake', false)) AS live_job, j0.schedulable
  FROM j0 LEFT JOIN lr ON lr.job_id = j0.id
 ), lo AS (
  -- (lead cutoff, 20261007010000) a live job that is a lead no longer followed up (still at quoted
  -- with no progress 28 days, 42 on a patio job since 20261009133000, after the newer of its newest
  -- quote send and the customer's newest text, email or call, wherever it is placed:
  -- context_lead_monitored_jobs, now) is not due a read, and its evidence is never read in full for
  -- the judgement
  SELECT lr.job_id FROM lr JOIN j ON j.id = lr.job_id WHERE j.live_job AND NOT lr.monitored
 ), cur AS (
  SELECT j.id AS job_id, public.context_ledger_current_generation(j.id) AS gid FROM j
 ), g AS (
  SELECT c.job_id, gen.id, gen.status, gen.reader, gen.evidence_until, gen.created_at, gen.checks
  FROM cur c JOIN public.context_ledger_generations gen ON gen.id = c.gid
 ), wait AS (
  -- (notes freshness, 20261009132000) the reading the go-live sweep would put live in place of a
  -- live one (context_ledger_promote_shadow's own choice): the job's newest shadow, newer than the
  -- live reading, by the current reader and passing its checks
  SELECT n.job_id, n.id, n.evidence_until
  FROM g CROSS JOIN s CROSS JOIN LATERAL (
   SELECT x.job_id, x.id, x.evidence_until, x.reader, x.checks, x.created_at FROM public.context_ledger_generations x
   WHERE x.job_id = g.job_id AND x.status = 'shadow' ORDER BY x.created_at DESC, x.id DESC LIMIT 1) n
  WHERE g.status = 'live' AND n.created_at > g.created_at AND n.reader = s.reader AND public.context_ledger_checks_pass(n.checks)
 ), cbe AS (
  -- The read every judgement can afford: the admitted business_events rows
  -- exactly (count and newest landed time, no text compare, no copy grouping)...
  SELECT e.job_id, count(*)::integer AS n,
   max(greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at)) AS newest,
   -- (CRM texts loaded later from the CRM's cache: one from before the job's lead window
   -- is not its evidence, story safety, 20261006040000)
   (count(*) FILTER (WHERE e.source = 'ghl_sms_cache_backfill'))::integer AS bf
  FROM j JOIN public.business_events e ON e.job_id = j.id
  WHERE j.live_job AND public.context_ledger_row_admissible(e) AND coalesce(e.event_at, e.occurred_at) <= now()
   AND greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) <= now()
  GROUP BY e.job_id
 ), ibx AS (
  -- ...and the legacy mail that could be evidence, before its copy checks (a superset)...
  SELECT j.id AS job_id, i.id, coalesce(i.processed_at, i.received_at) AS landed
  FROM j JOIN public.inbox_events i ON i.job_id = j.id WHERE j.live_job AND i.received_at <= now()
  UNION ALL
  SELECT j.id, i.id, coalesce(i.processed_at, i.received_at)
  FROM j JOIN public.jobs jb ON jb.id = j.id
  JOIN public.inbox_events i ON lower(btrim(i.from_email)) = lower(nullif(btrim(jb.client_email), '')) AND i.job_id IS NULL
  WHERE j.live_job AND i.received_at <= now() AND i.received_at >= jb.created_at - interval '30 days'
   AND NOT (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
   OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
    AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id))
 ), cpy AS MATERIALIZED (
  -- ...on a job with a reading, each no earlier than it can have joined the job's evidence,
  -- as the full read times it: a mail whose saved copy sits on another job or on no job
  -- joined no earlier than that rule's first apply and the copy's own landing (story
  -- safety, 20261006040000). A never-read job's judgement does not turn on it.
  SELECT c.mail_id, c.copy_job_id, c.joined_at
  FROM public.context_ledger_mail_copies(ARRAY(SELECT DISTINCT x.id FROM ibx x WHERE x.job_id IN (SELECT g.job_id FROM g))) c
 ), cib AS (
  SELECT x.job_id, count(DISTINCT x.id)::integer AS n, max(greatest(x.landed, c.joined_at)) AS newest
  FROM ibx x LEFT JOIN cpy c ON c.mail_id = x.id AND c.copy_job_id IS DISTINCT FROM x.job_id
  WHERE x.landed <= now()
  GROUP BY x.job_id
 ), need AS (
  -- The full evidence read (text, copies) only where it can change the judgement:
  -- a reading whose newest possible evidence is past its evidence_until, or a
  -- never-read job whose only possible evidence is legacy mail, or whose admitted rows
  -- are all CRM texts loaded from the cache (the evidence leaves out one from before the
  -- job's lead window, so it may hold none: story safety, 20261006040000). (Notes freshness,
  -- 20261009132000) Also a job whose waiting shadow may not have read a row (the answer below).
  SELECT j.id FROM j LEFT JOIN g ON g.job_id = j.id LEFT JOIN cbe ON cbe.job_id = j.id LEFT JOIN cib ON cib.job_id = j.id
  LEFT JOIN wait w ON w.job_id = j.id
  WHERE j.live_job AND NOT EXISTS (SELECT 1 FROM lo WHERE lo.job_id = j.id)
   AND (CASE WHEN g.id IS NULL THEN (coalesce(cbe.n, 0) = 0 AND coalesce(cib.n, 0) > 0)
                                                    OR (coalesce(cbe.n, 0) > 0 AND cbe.n = cbe.bf)
                             ELSE g.evidence_until IS NULL OR greatest(cbe.newest, cib.newest) > g.evidence_until END
        OR (w.job_id IS NOT NULL AND (w.evidence_until IS NULL OR greatest(cbe.newest, cib.newest) > w.evidence_until)))
 ), er AS MATERIALIZED (
  SELECT r.job_id, r.src_id, r.at, r.landed_at, r.copy_of, r.automated
  FROM public.context_ledger_evidence_rows(ARRAY(SELECT need.id FROM need), now()) r
 ), ev AS (
  -- Exact where read in full; elsewhere the cheap read gives the same judgement
  -- (newest only ever overstates, by legacy copies, and stays at or before the
  -- reading's evidence_until; a count above zero stays above zero).
  SELECT j.id AS job_id,
   CASE WHEN nd.id IS NOT NULL THEN (SELECT max(r.landed_at) FROM er r WHERE r.job_id = j.id)
        ELSE greatest(cbe.newest, cib.newest) END AS newest,
   CASE WHEN nd.id IS NOT NULL THEN (SELECT (count(*) FILTER (WHERE r.copy_of IS NULL))::integer FROM er r WHERE r.job_id = j.id)
        ELSE coalesce(cbe.n, 0) + coalesce(cib.n, 0) END AS n
  FROM j LEFT JOIN need nd ON nd.id = j.id LEFT JOIN cbe ON cbe.job_id = j.id LEFT JOIN cib ON cib.job_id = j.id
  WHERE j.live_job
 ), moved AS (
  -- An item of the current generation citing a business_events row that is
  -- gone, on another job, or no longer admissible. A person-locked item is
  -- left out: a rebuild carries it straight back, so it waits for a person
  -- (the story says so) instead of looping. (Story safety, eighth review) Also a
  -- citation the citation check refuses now, as the story's ledger read re-checks
  -- it (context_job_story_ledger): a CRM text loaded from the cache whose CRM time
  -- is not kept or is more than 30 days before the job was created (a reading from
  -- before this migration may cite SWF-261419's June texts), and an old-inbox mail
  -- now placed on another job, or with a saved copy on this job or another live job
  -- (its copy filed there after the reading).
  SELECT DISTINCT i.job_id FROM g JOIN public.context_ledger_items i ON i.generation_id = g.id AND NOT i.person_locked
  JOIN public.jobs jb ON jb.id = i.job_id
  CROSS JOIN LATERAL jsonb_array_elements(i.opened_by || coalesce(i.closed_by, '[]'::jsonb)) c(cite)
  LEFT JOIN public.business_events b ON c.cite ->> 'table' = 'business_events'
   AND b.id = CASE WHEN c.cite ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c.cite ->> 'id')::uuid END
  LEFT JOIN public.inbox_events m ON c.cite ->> 'table' = 'inbox_events'
   AND m.id = CASE WHEN c.cite ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c.cite ->> 'id')::uuid END
  WHERE (c.cite ->> 'table' = 'business_events'
         AND (b.id IS NULL OR b.job_id IS DISTINCT FROM i.job_id OR NOT public.context_event_source_admissible(b)
              OR (b.source = 'ghl_sms_cache_backfill'
                  AND coalesce(public.context_job_record_crm_time(b.source, b.contact_id,
                                 coalesce(nullif(btrim(b.payload ->> 'ghl_message_id'), ''), substring(b.provider_message_id FROM '^ghl:(.+)$')), b.job_id)
                               < jb.created_at - interval '30 days', true))))
     OR (c.cite ->> 'table' = 'inbox_events'
         AND NOT coalesce(m.id IS NOT NULL AND m.received_at IS NOT NULL
              AND (m.job_id = i.job_id
                   OR (m.job_id IS NULL AND lower(nullif(btrim(jb.client_email), '')) IS NOT NULL
                       AND lower(btrim(m.from_email)) = lower(nullif(btrim(jb.client_email), ''))
                       AND m.received_at >= jb.created_at - interval '30 days'
                       AND NOT EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
                       AND NOT EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
                                       AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id)))
              AND coalesce(m.classification, '') NOT IN ('spam', 'newsletter')
              AND coalesce(m.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
              AND btrim(coalesce(m.subject, '') || coalesce(m.body_preview, '')) <> ''
              AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.source_table = 'inbox_events' AND x.source_id = m.id::text
                               AND (x.job_id = i.job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = x.job_id
                                    AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                    AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
              AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE m.graph_message_id IS NOT NULL AND x.provider_message_id = 'graph:' || m.graph_message_id
                               AND (x.job_id = i.job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = x.job_id
                                    AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                    AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
              AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.source_table IS NULL
                               AND x.payload @> jsonb_build_object('inbox_events_id', m.id::text)
                               AND (x.job_id = i.job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = x.job_id
                                    AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                    AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
              AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.channel = 'email' AND coalesce(x.event_at, x.occurred_at) = m.received_at
                               AND lower(btrim(coalesce(x.payload ->> 'from', x.payload ->> 'from_email'))) = lower(btrim(m.from_email))
                               AND x.job_id = i.job_id), false))
 ), answered AS (
  -- A newer passing reading by the current reader already answers a rebuild of
  -- the live one (it waits for promotion); one that failed its checks answers
  -- it only while the job backs off. (Notes freshness, 20261009132000) Only the one the
  -- go-live sweep would promote (wait), and only while it has read every row by the one rule
  -- (context_ledger_row_unread): the sweep never promotes a reading with a row it has not read,
  -- and a shadow beside a live reading is never updated, so such a one would wait for ever.
  SELECT w.job_id FROM wait w
  WHERE NOT EXISTS (SELECT 1 FROM er r WHERE r.job_id = w.job_id AND r.copy_of IS NULL
                     AND public.context_ledger_row_unread(r.landed_at, r.automated, w.evidence_until))
 ), unr AS (
  -- (notes freshness, 20261009132000) the newest landing of a row the job's reading has not read
  -- by the one rule (not automated, landed after its evidence_until; copies left out). Read in
  -- full wherever a row can have landed after the reading, so a job not read in full has none.
  SELECT r.job_id, max(r.landed_at) AS newest
  FROM er r JOIN g ON g.job_id = r.job_id
  WHERE r.copy_of IS NULL AND public.context_ledger_row_unread(r.landed_at, r.automated, g.evidence_until)
  GROUP BY r.job_id
 ), fnew AS (
  -- Where the unread evidence starts (the earliest row that landed after the reading).
  SELECT DISTINCT ON (r.job_id) r.job_id, r.at, r.src_id
  FROM er r JOIN g ON g.job_id = r.job_id
  WHERE r.copy_of IS NULL AND g.evidence_until IS NOT NULL AND r.landed_at > g.evidence_until
  ORDER BY r.job_id, r.at, r.src_id
 ), late AS (
  -- How much already-read evidence follows it (an update packet carries all of it).
  SELECT f.job_id, f.at AS first_new_at,
   (count(*) FILTER (WHERE r.copy_of IS NULL AND r.landed_at <= g.evidence_until AND (r.at, r.src_id) > (f.at, f.src_id)))::integer AS read_after
  FROM fnew f JOIN g ON g.job_id = f.job_id JOIN er r ON r.job_id = f.job_id
  GROUP BY f.job_id, f.at
 ), fail AS (
  SELECT f.* FROM public.context_ledger_failures(ARRAY(SELECT j.id FROM j)) f
 ), busy AS (
  SELECT j.id AS job_id,
   EXISTS (SELECT 1 FROM public.context_ledger_generations bg JOIN public.context_extraction_runs br ON br.id = bg.run_id
    WHERE bg.job_id = j.id AND bg.status = 'building' AND br.status = 'running' AND br.lease_expires_at > now()) AS building_live,
   EXISTS (SELECT 1 FROM public.context_ledger_generations bg LEFT JOIN public.context_extraction_runs br ON br.id = bg.run_id
    WHERE bg.job_id = j.id AND bg.status = 'building'
     AND coalesce(br.lease_expires_at, br.finished_at, bg.updated_at) > now() - interval '2 hours'
     AND NOT (br.status = 'running' AND br.lease_expires_at > now())) AS building_lapsed_recent,
   EXISTS (SELECT 1 FROM public.context_extraction_runs r WHERE r.job_id = j.id AND r.phase = 'ledger'
    AND r.status = 'running' AND r.lease_expires_at > now()) AS run_live
  FROM j
 ), rq AS (
  -- (rebuild request, 20261013153000) the jobs an operator asked to have read again whole, whose
  -- request no reading made since has answered (context_ledger_rebuild_request_state: pending).
  -- No request on file: no row, and every job is judged as it was
  SELECT DISTINCT q.job_id FROM public.context_ledger_rebuild_request_state(p_job_ids) q WHERE q.state = 'pending'
 ), judged AS (
  SELECT j.id AS job_id, ev.newest, coalesce(ev.n, 0) AS n, g.id AS gid,
   CASE WHEN g.id IS NULL THEN 'never_read'
    WHEN g.status = 'shadow' AND NOT public.context_ledger_checks_pass(g.checks) THEN 'checks_failed'
    WHEN m.job_id IS NOT NULL AND a.job_id IS NULL THEN 'citation_moved'
    WHEN g.reader IS DISTINCT FROM s.reader AND a.job_id IS NULL THEN 'reader_changed'
    WHEN g.evidence_until IS NULL OR g.evidence_until < ev.newest THEN
     CASE WHEN lt.first_new_at < g.evidence_until - interval '14 days' OR lt.read_after > 150 THEN 'late_evidence'
      ELSE 'new_evidence' END
    -- (rebuild request, 20261013153000) last, so a request never takes the place of a read the job
    -- is due anyway: a job never read, another rebuild or an update keeps its own reason and goes first
    WHEN q.job_id IS NOT NULL THEN 'rebuild_requested' END AS reason,
   CASE WHEN s.mode = 'off' THEN 'ledger_off' WHEN NOT s.lane THEN 'lane_off'
    WHEN s.job_ids IS NOT NULL AND NOT (j.id = ANY(s.job_ids)) THEN 'not_in_rollout' WHEN NOT j.live_job THEN 'not_live'
    WHEN NOT j.schedulable THEN 'holding_job' WHEN lo.job_id IS NOT NULL THEN 'lead_not_monitored'
    WHEN coalesce(ev.n, 0) = 0 THEN 'no_evidence'
    WHEN b.building_live OR b.run_live THEN 'busy'
    WHEN f.needs_person THEN 'needs_person'
    WHEN f.backoff_until > now() OR b.building_lapsed_recent THEN 'backoff' END AS blocked,
   -- (notes freshness, 20261009132000) a row the reading has not read landed after the last failed
   -- read ended (a read that lost its building lease in the last 2 hours still holds the job)
   coalesce(u.newest > coalesce(f.last_failure_at, '-infinity'::timestamptz) AND NOT b.building_lapsed_recent, false) AS fresh
  FROM j CROSS JOIN s LEFT JOIN ev ON ev.job_id = j.id LEFT JOIN g ON g.job_id = j.id
  LEFT JOIN moved m ON m.job_id = j.id LEFT JOIN answered a ON a.job_id = j.id LEFT JOIN late lt ON lt.job_id = j.id
  LEFT JOIN fail f ON f.job_id = j.id LEFT JOIN busy b ON b.job_id = j.id LEFT JOIN lo ON lo.job_id = j.id
  LEFT JOIN unr u ON u.job_id = j.id
  LEFT JOIN rq q ON q.job_id = j.id
 )
 SELECT d.job_id, d.blk IS NULL AND d.reason IS NOT NULL,
  CASE WHEN d.reason IS NULL THEN NULL WHEN d.reason = 'never_read' THEN 'backfill' WHEN d.reason = 'new_evidence' THEN 'update'
   ELSE 'rebuild' END,
  d.reason,
  CASE d.reason WHEN 'citation_moved' THEN 1 WHEN 'new_evidence' THEN 1 WHEN 'late_evidence' THEN 1 WHEN 'never_read' THEN 2
   WHEN 'reader_changed' THEN 3 WHEN 'checks_failed' THEN 3 WHEN 'rebuild_requested' THEN 3 END,
  d.newest, d.n, d.gid, d.blk
 FROM (  -- backfills and rebuilds wait for the backfill hours; an update is never held, (notes
         -- freshness, 20261009132000) nor held back by the backoff of failed reads for a row that
         -- landed after the last of them ended: the reading reads it at once
  SELECT d0.*, coalesce(CASE WHEN d0.blocked = 'backoff' AND d0.reason = 'new_evidence' AND d0.fresh THEN NULL ELSE d0.blocked END,
                        CASE WHEN NOT s.window_open AND d0.reason IS NOT NULL AND d0.reason <> 'new_evidence'
                             THEN 'outside_window' END) AS blk
  FROM judged d0 CROSS JOIN s) d
$$;
COMMENT ON FUNCTION public.context_ledger_judge(uuid[]) IS
 'Context ledger store (20261006013000), story safety (20261006040000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) (rebuild request, 20261013153000) A rebuild an operator asked for: a job with a request on file that no reading has answered yet (context_ledger_rebuild_request_state: state pending; context_ledger_request_rebuild files one) is due kind rebuild, reason rebuild_requested, priority 3 with the reader-change rebuilds, and only when the judgement has no reason of its own for the job: a job never read, a failed-check, moved-citation, reader-change or late-evidence rebuild and a new-evidence update each keep their own reason and are read first. Every block holds it as it holds any rebuild (ledger_off, lane_off, not_in_rollout, not_live, holding_job, lead_not_monitored, no_evidence, busy, needs_person, backoff, outside_window). It is due once: a whole reading made after the request that passes its checks or went live answers it, whatever reason that reading was claimed for, and after three whole readings made after it that failed it is given up. With no request on file every job is judged exactly as before. Earlier (finished wake): The owner''s 12 Oct 2026 ruling: a finished job (cancelled, archived, complete, completed or lost) is live, and so due a read as any live job (never read: a backfill; a new message: an update), only while the lead rule calls it awake (context_lead_monitored_jobs state finished_awake: a real inbound message of its customer''s on the job inside 30 days, context_finished_wake_hours); a quiet one is blocked not_live, as every finished job was, and its notes stay. The rule is read once for every job asked about. Earlier (scoping pipeline): The lead rule is read once for unfinished jobs including drafts; a draft is live only while monitored from its own activity inside four weeks (six for patio), else blocked not_live. (notes freshness, 20261009132000) a row a reading has not read is the ledger''s one rule (context_ledger_row_unread: a row of the evidence that is not automated and landed after the reading''s evidence_until, copies left out; landing covers a row whose own time is earlier, such as a late call transcript, a late-captured email or a backfilled text). An update is never held by the backoff of failed reads for such a row that landed after the last failed read ended (a read that lost its building lease in the last 2 hours still holds the job; a backfill or rebuild backs off as before). A rebuild of a live reading (moved citation, changed reader) is answered only by the reading the go-live sweep would promote: the job''s newest shadow, newer than the live one, by the current reader, passing its checks, with no row it has not read; the sweep never promotes one with such a row and a shadow beside a live reading is never updated, so such a one answers nothing. Earlier (lead cutoff, 20261007010000) blocked lead_not_monitored: a live job that is a lead no longer followed up (context_lead_monitored_jobs as of now: still at quoted with no acceptance, Xero invoice or bill, booking or later status 28 days after the newer of its newest quote send and the customer''s newest text, email or call, wherever it is placed) is never due a read, so context_ledger_due never lists it and a claim answers not_due; its evidence is not read in full. It is due again the moment it progresses or the customer writes. Earlier (eighth review) citation_moved also takes an item whose citation the citation check refuses now, as the story''s ledger read re-checks it: a CRM text loaded from the cache whose CRM time is not kept or is more than 30 days before the job was created, and an old-inbox mail now placed on another job (or from the client''s address on no job while the client has another job, or from before the job''s lead window), not worded, spam, a newsletter or an auto-reply, or with a saved copy on this job or another live job (the judge''s live set); a mail''s copies time it from when one left a live job (context_ledger_mail_copies). Earlier: a legacy mail whose saved copy sits on another job or on no job counts from when it can have joined the job''s evidence (context_ledger_mail_copies: no earlier than that rule''s first apply and the copy''s own landing), in the quick read (for a job with a reading) as in the full one, so a reading built before then is never taken to have read it and the job is due; (seventh review) one whose copy sits on another live job is not this job''s evidence at all: the full read leaves it out, and the quick read, a superset, may only overstate by it and then reads the job in full; a never-read job''s quick read is as before, except that a never-read job whose admitted rows are all CRM texts loaded from the cache (source ghl_sms_cache_backfill) is read in full, since the evidence leaves out one dated before the job''s lead window and so may hold none (then it is no_evidence, never a backfill of nothing). Earlier: the one ledger due judgement per job (the full evidence read only for a job whose reading may have newer evidence or whose only possible evidence is legacy mail; elsewhere a count and newest landed time of the admitted rows decide the same; evidence_rows is then that count): kind backfill (never_read), update (new_evidence: the current generation''s evidence_until is older than the newest admissible evidence), or rebuild (checks_failed: the current reading is a shadow whose checks.passed is false; citation_moved: an item cites a business_events row now gone, off the job or not admissible; reader_changed; late_evidence: the earliest unread row is more than 14 days older than evidence_until, or more than 150 already-read rows follow it). A rebuild of the live reading for a moved citation or a changed reader is not due while a newer passing shadow by the current reader waits for promotion. Blocked: ledger_off, lane_off, not_in_rollout (settings.job_ids is set and does not list the job), not_live, holding_job, no_evidence, busy (a live building generation or a running ledger run), needs_person (three builds in a row failed their checks: context_ledger_failures), backoff (consecutive failed or check-failed runs: 2 hours, 8 hours, the next Perth day, then 7 days; or a building generation that lost its lease in the last 2 hours), outside_window (a backfill or rebuild outside the settings backfill hours; an update is never held). A person-locked item is never a moved citation (a rebuild would carry it back). Service role only.';

-- 5. Access: service role only (CREATE OR REPLACE keeps a replaced function's grants; said again).
REVOKE ALL ON FUNCTION public.context_ledger_judge(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_judge(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_rebuild_request_state(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_rebuild_request_state(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_request_rebuild(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_request_rebuild(uuid, text, text) TO service_role;
