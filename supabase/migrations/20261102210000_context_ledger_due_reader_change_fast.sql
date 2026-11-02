-- Context AI notes: the due list stays fast after a reader move, 2 Nov 2026.
--
-- After the reader setting moves to a new reader, every live job is judged
-- due as 'reader_changed'. context_ledger_due then read the evidence rows of
-- every such job (the w CTE, for ordering) before its LIMIT: over 45 s on
-- 2 Nov 2026, past the worker's 30 s limit, so the notes worker could not
-- list due jobs and read nothing (context_ledger_due_failed, 04:37-04:43Z).
-- The w ordering now runs only for rows that are not reader-change rebuilds;
-- those already order by their customer's newest message (c.at), then newest
-- evidence. Rows, kinds and reasons are unchanged; only the order among
-- reader-change rebuilds whose customer messages tie can differ. Rehearsed
-- on production and rolled back: under the current reader, the same 23 rows
-- in the same order; under the new reader, 50 rows in 11.4 s.
-- Rollback: supabase/rollbacks/20261102210000_context_ledger_due_reader_change_fast_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF position('ARRAY(SELECT d.job_id FROM d WHERE d.generation_id IS NOT NULL), now()) r' IN
       pg_get_functiondef('public.context_ledger_due(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'context_ledger_due is not the expected definition; refusing to replace it';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.context_ledger_due(p_limit integer DEFAULT 20)
 RETURNS TABLE(job_id uuid, kind text, reason text, priority integer, newest_evidence_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH st AS (SELECT x.mode, x.job_ids FROM public.context_ledger_settings x WHERE x.id),
 d AS MATERIALIZED (
  SELECT jd.job_id, jd.kind, jd.reason, jd.priority, jd.newest_evidence_at, jd.generation_id
  FROM public.context_ledger_judge(ARRAY(
    -- only jobs the judgement could find due: live, the lane on, in the rollout list
    SELECT jb.id FROM public.jobs jb, st
    WHERE jb.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost')
     AND st.mode <> 'off' AND public.automation_lane_enabled('extraction')
     AND (st.job_ids IS NULL OR jb.id = ANY(st.job_ids))
    UNION ALL
    -- (scoping pipeline, 20261009133000) drafts that the lead rule monitors from real activity on
    -- that draft inside its window; they enter the same judge and freshness ordering as live jobs
    SELECT m.job_id FROM public.context_lead_monitored_jobs(ARRAY(
      SELECT jb.id FROM public.jobs jb, st
      WHERE jb.status::text = 'draft' AND st.mode <> 'off' AND public.automation_lane_enabled('extraction')
       AND (st.job_ids IS NULL OR jb.id = ANY(st.job_ids))), now()) m
    WHERE m.monitored
    UNION ALL
    -- (finished wake, 20261012093500) finished jobs the lead rule calls awake (a real inbound message
    -- of the customer's on the job inside 30 days); they enter the same judge and freshness ordering
    SELECT m.job_id FROM public.context_lead_monitored_jobs(ARRAY(
      SELECT jb.id FROM public.jobs jb, st
      WHERE jb.status::text IN ('cancelled','archived','complete','completed','lost') AND st.mode <> 'off'
       AND public.automation_lane_enabled('extraction')
       AND (st.job_ids IS NULL OR jb.id = ANY(st.job_ids))), now()) m
    WHERE m.state = 'finished_awake')) jd
  WHERE jd.due
 ), w AS (
  -- (notes freshness, 20261009132000) since when each due job's reading has not read a row by the
  -- ledger's one rule (context_ledger_row_unread; copies left out): the earliest landing of one
  SELECT r.job_id, min(r.landed_at) AS since
  -- (due under a reader change, 20261102210000) only for rows that are not reader-change rebuilds:
  -- after a reader move every live job is due as reader_changed, and reading every one of their
  -- evidence rows before the LIMIT took over 45 s (the worker's limit is 30 s, so it read nothing).
  -- Reader-change rebuilds order by their customer's newest message (c.at), then newest evidence.
  FROM public.context_ledger_evidence_rows(ARRAY(SELECT d.job_id FROM d WHERE d.generation_id IS NOT NULL AND d.reason IS DISTINCT FROM 'reader_changed'), now()) r
  JOIN d ON d.job_id = r.job_id JOIN public.context_ledger_generations g ON g.id = d.generation_id
  WHERE r.copy_of IS NULL AND public.context_ledger_row_unread(r.landed_at, r.automated, g.evidence_until)
  GROUP BY r.job_id
 ), c AS (
  -- (rebuild order, 20261012164500) the customer's newest real inbound message on each job due a
  -- reader-change rebuild, by the one test the finished wake reads a customer's message by
  -- (context_job_record_messages: a text, email or call from the customer's side, on the job, or
  -- their old-inbox mail from the client's address on no job when they have no other job; never
  -- ours, staff's or crew's, another party's, automated, a copy, a text from before the job's lead
  -- window or one whose CRM time is not kept). Read per job with plain arguments, so the helper is
  -- inlined and only that job's own rows are read (12 Oct 2026: 520 such jobs, 1.3 s)
  SELECT d.job_id, max(m.at) AS at
  FROM d CROSS JOIN LATERAL public.context_job_record_messages(ARRAY[d.job_id], now()) m
  WHERE d.reason = 'reader_changed' AND m.customer_side AND m.direction = 'inbound' AND m.channel IN ('sms', 'email', 'call')
    AND m.placement IN ('on_job', 'not_placed') AND NOT m.automated AND NOT m.internal AND m.at <= now()
  GROUP BY d.job_id
 )
 SELECT d.job_id, d.kind, d.reason, d.priority, d.newest_evidence_at
 FROM d LEFT JOIN w ON w.job_id = d.job_id LEFT JOIN c ON c.job_id = d.job_id
 -- within a priority the updates first (cheap, never held by the backfill hours, and what keeps a
 -- reading current; a rebuild a reader skips once read that day never pushes them out of a capped
 -- page), each by the longest wait for a row it has not read, so a busy job's newest messages never
 -- keep an older one waiting; then the rest newest evidence first.
 -- (rebuild order, 20261012164500) Among the reader-change rebuilds, the job whose customer wrote
 -- most recently comes first (c.at), ahead of those whose customer never wrote. Only a reader-change
 -- rebuild has a c.at, so every other row sorts by the keys it had, in the order it had
 ORDER BY d.priority, d.kind IS DISTINCT FROM 'update', c.at DESC NULLS LAST, w.since NULLS LAST, d.newest_evidence_at DESC NULLS LAST,
  d.job_id
 LIMIT greatest(0, least(coalesce(p_limit, 20), 200))
$function$;
