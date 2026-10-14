-- Rollback for 20261012164500_context_rebuild_order.sql: puts back the due list's body and comment
-- as they were before it, word for word (the finished wake's, 20261012093500). The signature, owner
-- and grants never changed, so nothing else moves: the reader-change rebuilds are ordered by the
-- longest wait for a row not read and then newest evidence first again, whatever their customers
-- wrote. No row is touched. Refuses unless the live body is this migration's or already the earlier
-- one (a re-run is a no-op): a later change to it must be rolled back first.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $guard$
DECLARE live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_due(integer)');
 IF live IS NULL OR NOT live = ANY (ARRAY['874180d1d58ffc8a35cbe167b9f33d6d', '15083363afc35bf335c81a78f2d5d13d']) THEN
  RAISE EXCEPTION 'context_rebuild_order_down_refused: public.context_ledger_due(integer) md5 %; a later change replaced this body, roll it back first',
   coalesce(live, '<missing>');
 END IF;
END $guard$;

-- The body and comment as they were before 20261012164500, word for word (finished wake,
-- 20261012093500).
CREATE OR REPLACE FUNCTION public.context_ledger_due(p_limit integer DEFAULT 20)
RETURNS TABLE(job_id uuid, kind text, reason text, priority integer, newest_evidence_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  FROM public.context_ledger_evidence_rows(ARRAY(SELECT d.job_id FROM d WHERE d.generation_id IS NOT NULL), now()) r
  JOIN d ON d.job_id = r.job_id JOIN public.context_ledger_generations g ON g.id = d.generation_id
  WHERE r.copy_of IS NULL AND public.context_ledger_row_unread(r.landed_at, r.automated, g.evidence_until)
  GROUP BY r.job_id
 )
 SELECT d.job_id, d.kind, d.reason, d.priority, d.newest_evidence_at
 FROM d LEFT JOIN w ON w.job_id = d.job_id
 -- within a priority the updates first (cheap, never held by the backfill hours, and what keeps a
 -- reading current; a rebuild a reader skips once read that day never pushes them out of a capped
 -- page), each by the longest wait for a row it has not read, so a busy job's newest messages never
 -- keep an older one waiting; then the rest newest evidence first
 ORDER BY d.priority, d.kind IS DISTINCT FROM 'update', w.since NULLS LAST, d.newest_evidence_at DESC NULLS LAST, d.job_id
 LIMIT greatest(0, least(coalesce(p_limit, 20), 200))
$$;
COMMENT ON FUNCTION public.context_ledger_due(integer) IS
 'Context ledger store (20261006013000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) The finished jobs the lead rule calls awake (cancelled, archived, complete, completed or lost, with a real inbound message of the customer''s on the job inside 30 days: context_lead_monitored_jobs state finished_awake) enter the same due list and freshness order as other live jobs; a quiet finished job is never listed. Earlier (scoping pipeline): The drafts the lead rule monitors enter the same due list and freshness order as other live jobs. (notes freshness, 20261009132000) within a priority the updates come first, then the rest, and within each the job whose reading has waited longest for a row it has not read by the ledger''s one rule (context_ledger_row_unread: not automated, landed after its evidence_until; copies left out) comes first, by the earliest landing of one, so a busy job''s newest messages never keep an older one waiting and a rebuild a reader skips once read that day never pushes an update out of a capped page; then the rest newest evidence first. The priorities are the judge''s, unchanged. Earlier: live jobs due a ledger read now (context_ledger_judge), new evidence and moved citations first, then never-read jobs newest evidence first, then reader changes. At most 200. Empty while context_ledger_settings.mode is off or the extraction lane is off; only jobs on settings.job_ids when that rollout list is set. Service role only.';

-- Access: service role only, as before (CREATE OR REPLACE keeps the grants; said again).
REVOKE ALL ON FUNCTION public.context_ledger_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_due(integer) TO service_role;
