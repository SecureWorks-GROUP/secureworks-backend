-- Rebuild order (12 Oct 2026): among the reader-change rebuilds, the job whose customer wrote most
-- recently is re-read first.
--
-- The owner's go (Marnin, 12 Oct 2026, on the context system state board, answering its ten
-- recommendations): "yes to all 10. get to work this is priority for the day."
--
-- Why. The reader v3 switch (12 Oct 2026, 03:31Z) made every live reading due a rebuild for a
-- changed reader (the judge's reader_changed, priority 3). The due list ordered them as it orders
-- every row inside a priority: the longest wait for a row not read, then newest evidence first.
-- Neither says whether anything is happening on the job, so a job its customer wrote to this
-- morning waited behind jobs nobody has written to in months. The Luna worker reads one job at a
-- time from the first 50 rows of this list, and SWF-261469, whose customer wrote today, sat at 150.
--
-- What it does. One sort key is added to context_ledger_due, after the two that keep the priorities
-- and put the updates first: the customer's newest real inbound message on the job, newest first,
-- read only for the reader-change rebuilds. So:
--  * a reader-change rebuild of a job whose customer wrote comes before one whose customer wrote
--    longer ago, and both before one whose customer never wrote; those last keep the order they had;
--  * every other row has no such message read for it, so it sorts by the keys it had: the updates,
--    the first reads, the moved-citation and late-evidence rebuilds and the failed-check rebuilds keep
--    the order they had among themselves, and nothing leaves or changes its priority;
--  * a failed-check rebuild (priority 3 too) now follows the reader-change rebuilds of jobs whose
--    customer has written, where before it sat among them by the same two keys.
-- A real inbound customer message is read by the one test the finished wake (20261012093500) reads
-- one by (context_job_record_messages: a text, email or call from the customer's side, on the job,
-- or their old-inbox mail from the client's address on no job when they have no other job; never
-- ours, staff's or crew's, another party's, automated, a copy, a text from before the job's lead
-- window or one whose CRM time is not kept), with no window: the newest one ever.
--
-- Read only on production (12 Oct 2026, about 16:50 Perth): context_ledger_due is the 20261012093500
-- body (md5 15083363afc35bf335c81a78f2d5d13d); ledger mode live, reader luna-ledger:v3. 530 jobs
-- are due: 520 reader-change rebuilds, 9 failed-check rebuilds and 1 late-evidence rebuild (the
-- list shows at most 200, so only 198 of them showed on it). 191 of the 520 have a real inbound
-- customer message. In the new order SWF-261469 is 2nd of 530 (150th before), behind only the
-- late-evidence rebuild; 49 of the first 50 rows are jobs whose customer has written; no priority 1
-- or 2 row moves. The list took 10.9 s before and 12.2 s with this body, inside the service role's
-- 30 s statement limit.
--
-- Replaced body (guarded on its live production md5, or this migration's own for a re-apply):
--  context_ledger_due, the 20261012093500 body word for word with one CTE (c) and one sort key
--  added, each marked "rebuild order", and its comment (the earlier slices' names first).
-- Not changed: the judge (what is due, its kind, reason and priority), the claim, the budgets, the
--  backfill hours, the settings, every flag, the reader, the story, every signature, volatility,
--  owner and grant. Nothing is written: no row, run, flag, cron job or setting changes.
-- Rollback: supabase/rollbacks/20261012164500_context_rebuild_order_down.sql (the 20261012093500
--  body and comment word for word; no row touched).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. The body replaced here must be the one production and main have before this migration
-- (md5 of prosrc, read 12 Oct 2026) or this migration's own; anything else is someone else's change
-- and is refused, never overwritten. The message helper the new body reads must exist with the
-- columns it reads.
DO $guard$
DECLARE problems text[] := '{}'; live text; cols text[];
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_due(integer)');
 IF live IS NULL OR NOT live = ANY (ARRAY['15083363afc35bf335c81a78f2d5d13d', '874180d1d58ffc8a35cbe167b9f33d6d']) THEN
  problems := problems || format('public.context_ledger_due(integer) md5 %s', coalesce(live, '<missing>'));
 END IF;
 SELECT p.proargnames INTO cols FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_record_messages(uuid[],timestamptz)');
 IF cols IS NULL THEN
  problems := problems || 'public.context_job_record_messages(uuid[],timestamptz) missing'::text;
 ELSIF NOT cols @> ARRAY['job_id', 'at', 'channel', 'direction', 'customer_side', 'internal', 'automated', 'placement'] THEN
  problems := problems || 'public.context_job_record_messages(uuid[],timestamptz) no longer returns the columns the order reads'::text;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_rebuild_order_preimage_mismatch: %; read the live definition before replacing it',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The due list: among the reader-change rebuilds, the job whose customer wrote most recently
-- first (20261012093500's body otherwise).
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
$$;
COMMENT ON FUNCTION public.context_ledger_due(integer) IS
 'Context ledger store (20261006013000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) (rebuild order, 20261012164500) The owner''s 12 Oct 2026 go: among the rebuilds due for a changed reader (reason reader_changed, priority 3), the job whose customer wrote most recently comes first: by the customer''s newest real inbound message on the job, newest first, read by the one test the finished wake reads a customer''s message by (context_job_record_messages: a text, email or call from the customer''s side, on the job, or their old-inbox mail from the client''s address on no job when they have no other job; never ours, staff''s or crew''s, another party''s, automated, a copy, a text from before the job''s lead window or one whose CRM time is not kept); a reader-change rebuild whose customer never wrote comes after them, in the order it had. Order only: every job due is still listed, each with the kind, reason and priority the judge gave it, and no other row has such a message read for it, so the updates, the first reads, the moved-citation and late-evidence rebuilds and the failed-check rebuilds keep the order they had among themselves; a failed-check rebuild (priority 3 too) now follows the reader-change rebuilds of jobs whose customer has written. Earlier (finished wake): The finished jobs the lead rule calls awake (cancelled, archived, complete, completed or lost, with a real inbound message of the customer''s on the job inside 30 days: context_lead_monitored_jobs state finished_awake) enter the same due list and freshness order as other live jobs; a quiet finished job is never listed. Earlier (scoping pipeline): The drafts the lead rule monitors enter the same due list and freshness order as other live jobs. (notes freshness, 20261009132000) within a priority the updates come first, then the rest, and within each the job whose reading has waited longest for a row it has not read by the ledger''s one rule (context_ledger_row_unread: not automated, landed after its evidence_until; copies left out) comes first, by the earliest landing of one, so a busy job''s newest messages never keep an older one waiting and a rebuild a reader skips once read that day never pushes an update out of a capped page; then the rest newest evidence first. The priorities are the judge''s, unchanged. Earlier: live jobs due a ledger read now (context_ledger_judge), new evidence and moved citations first, then never-read jobs newest evidence first, then reader changes. At most 200. Empty while context_ledger_settings.mode is off or the extraction lane is off; only jobs on settings.job_ids when that rollout list is set. Service role only.';

-- 2. Access: service role only (CREATE OR REPLACE keeps a replaced function's grants; said again).
REVOKE ALL ON FUNCTION public.context_ledger_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_due(integer) TO service_role;
