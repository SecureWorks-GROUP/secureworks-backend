-- FU20 part 2: read the mark stores directly, without expanding the all-job view.
-- Existing live worker read changes immediately; no switch, trigger or schedule.
-- Follow the pending-marker index build budgets. No business row is rewritten.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE INDEX IF NOT EXISTS job_change_mark_events_worker_newest
  ON public.job_change_mark_events (marked_at DESC) INCLUDE (job_id);
CREATE INDEX IF NOT EXISTS job_change_marks_base_worker_newest
  ON public.job_change_marks_base (last_marked_at DESC);
CREATE INDEX IF NOT EXISTS job_change_mark_events_worker_notes
  ON public.job_change_mark_events (job_id, marked_at DESC);
CREATE INDEX IF NOT EXISTS job_change_marks_base_worker_notes
  ON public.job_change_marks_base (job_id) INCLUDE (last_marked_at)
  WHERE notes_done_at IS NULL OR last_marked_at > notes_done_at;

CREATE OR REPLACE FUNCTION public.context_worker_marks_newest() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT max(q.marked_at) FROM (
    (SELECT b.last_marked_at AS marked_at FROM public.job_change_marks_base b
      ORDER BY b.last_marked_at DESC LIMIT 1)
    UNION ALL
    (SELECT e.marked_at FROM (
      -- Keep the ordered index stream below the orphan filter. Putting only
      -- OFFSET 0 on the jobs probe lets PostgreSQL choose a full raw scan/sort.
      SELECT r.job_id, r.marked_at FROM public.job_change_mark_events r
      ORDER BY r.marked_at DESC OFFSET 0
    ) e
      -- The raw heap deliberately has no FK. Retain the view's orphan exclusion.
      WHERE EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = e.job_id OFFSET 0)
      ORDER BY e.marked_at DESC LIMIT 1)
  ) q
$fn$;

CREATE OR REPLACE FUNCTION public.context_worker_notes_due() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT count(*) FROM (
    (SELECT b.job_id FROM public.job_change_marks_base b
      WHERE (b.notes_done_at IS NULL OR b.last_marked_at > b.notes_done_at)
        AND NOT EXISTS (SELECT 1 FROM public.job_notes_marks_seen n
          WHERE n.job_id = b.job_id AND n.notes_done_at >= b.last_marked_at OFFSET 0)
      ORDER BY b.job_id LIMIT 50)
    UNION
    (SELECT e.job_id FROM (
        SELECT DISTINCT ON (r.job_id) r.job_id, r.marked_at
        FROM public.job_change_mark_events r ORDER BY r.job_id, r.marked_at DESC
      ) e
      WHERE EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = e.job_id OFFSET 0)
        AND NOT EXISTS (SELECT 1 FROM public.job_change_marks_base b
          WHERE b.job_id = e.job_id AND b.notes_done_at >= e.marked_at OFFSET 0)
        AND NOT EXISTS (SELECT 1 FROM public.job_notes_marks_seen n
          WHERE n.job_id = e.job_id AND n.notes_done_at >= e.marked_at OFFSET 0)
      ORDER BY e.job_id LIMIT 50)
    LIMIT 50
  ) due_notes
$fn$;

REVOKE ALL ON FUNCTION public.context_worker_marks_newest(), public.context_worker_notes_due()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_worker_marks_newest(), public.context_worker_notes_due()
  TO service_role;
COMMENT ON FUNCTION public.context_worker_marks_newest() IS
  'FU20 part 2: maximum of two ordered one-row index probes; raw marks require a live jobs_pkey match. No all-job view expansion.';
COMMENT ON FUNCTION public.context_worker_notes_due() IS
  'FU20 part 2: unchanged notes count capped at 50 distinct jobs. Each indexed source emits at most 50 jobs before the bounded union. Raw history streams in job order, checks both acknowledgement stores by primary key, and may traverse acknowledged history when the queue is empty. No per-job mark aggregate or all-job view expansion.';

DO $patch$
DECLARE
  definition text := pg_get_functiondef('public.context_worker_state()'::regprocedure);
  old_notes text := '(SELECT count(*) FROM (SELECT 1 FROM public.job_change_marks m
        WHERE m.notes_done_at IS NULL OR m.last_marked_at > m.notes_done_at LIMIT 50) due_notes)';
  old_newest text := '(SELECT max(m.last_marked_at) FROM public.job_change_marks m)';
/* patch block */ BEGIN
  IF position(old_notes IN definition) > 0 AND position(old_newest IN definition) > 0 THEN
    EXECUTE replace(replace(definition, old_notes, 'public.context_worker_notes_due()'),
      old_newest, 'public.context_worker_marks_newest()');
  ELSIF position('public.context_worker_notes_due()' IN definition) = 0
    OR position('public.context_worker_marks_newest()' IN definition) = 0 THEN
    RAISE EXCEPTION 'worker mark reads: state pre-image changed';
  END IF;
END $patch$;
