-- P0-03.1 follow-up: bounded wake signal, not a due-facts judgement.
-- A positive signal may include blocked, inadmissible or already-read evidence.
-- Only the unchanged cadence/claim path decides whether to extract anything.
-- This intentionally over-wakes: limiting the jobs judged could miss a due job.
-- Ordinary index builds take SHARE locks; use the pending-marker lock budget.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE INDEX IF NOT EXISTS business_events_worker_facts_present
  ON public.business_events (context_captured_at)
  WHERE job_id IS NOT NULL
    AND metadata->>'written_as' = 'service_role'
    AND coalesce(metadata->>'capture_mode', 'live') = 'live';

CREATE INDEX IF NOT EXISTS context_catchup_jobs_worker_present
  ON public.context_catchup_jobs (job_id) WHERE done_at IS NULL;

-- job_change_marks is a view since the queue-safety migration. Its newest mark
-- is the greatest of the folded base and the raw events for jobs that exist.
CREATE INDEX IF NOT EXISTS job_change_marks_base_newest
  ON public.job_change_marks_base (last_marked_at DESC) INCLUDE (job_id);
CREATE INDEX IF NOT EXISTS job_change_mark_events_newest
  ON public.job_change_mark_events (marked_at DESC) INCLUDE (job_id);

COMMENT ON INDEX public.business_events_worker_facts_present IS
  'P0-03.1 conservative worker wake: seek live_since, stop at the first placed service-role live-capture candidate, without reading payloads or judging jobs.';
COMMENT ON INDEX public.context_catchup_jobs_worker_present IS
  'P0-03.1 conservative worker wake: first unfinished catch-up request, including blocked requests.';
COMMENT ON INDEX public.job_change_marks_base_newest IS
  'P0-03.1 newest folded mark, including fully acknowledged marks, with job identity for the existing-job check.';
COMMENT ON INDEX public.job_change_mark_events_newest IS
  'P0-03.1 newest raw mark, including acknowledged events, with job identity for the existing-job check.';

CREATE OR REPLACE FUNCTION public.context_worker_facts_present() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT CASE WHEN NOT public.automation_lane_enabled('extraction') THEN 0
    WHEN EXISTS (
      SELECT 1 FROM public.business_events e
      WHERE e.job_id IS NOT NULL
        AND e.metadata->>'written_as' = 'service_role'
        AND coalesce(e.metadata->>'capture_mode', 'live') = 'live'
        AND e.context_captured_at >= (public.context_cadence_policy()->>'live_since')::timestamptz
      LIMIT 1
    ) OR EXISTS (
      SELECT 1 FROM public.context_catchup_jobs c WHERE c.done_at IS NULL LIMIT 1
    ) THEN 1 ELSE 0 END
$fn$;
REVOKE ALL ON FUNCTION public.context_worker_facts_present() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_worker_facts_present() TO service_role;
COMMENT ON FUNCTION public.context_worker_facts_present() IS
  'P0-03.1 work-present signal, not a count or due verdict. Lane off = 0; lane on = 1 for a live-capture candidate since live_since or unfinished catch-up. Includes read or blocked work, never authorises extraction. Two indexed existence probes, no cadence pool, receipts or payload read.';

CREATE OR REPLACE FUNCTION public.context_worker_marks_newest() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT max(q.marked_at) FROM (
    (SELECT b.last_marked_at AS marked_at FROM public.job_change_marks_base b
     WHERE EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = b.job_id)
     ORDER BY b.last_marked_at DESC LIMIT 1)
    UNION ALL
    (SELECT e.marked_at FROM public.job_change_mark_events e
     WHERE EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = e.job_id)
     ORDER BY e.marked_at DESC LIMIT 1)
  ) q
$fn$;
REVOKE ALL ON FUNCTION public.context_worker_marks_newest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_worker_marks_newest() TO service_role;
COMMENT ON FUNCTION public.context_worker_marks_newest() IS
  'P0-03.1 exact max(last_marked_at) of the job_change_marks view, without its per-job aggregation. Two ordered index probes retain only jobs that exist (jobs_pkey); orphan events never move the marker. May inspect multiple orphan index entries before finding a live job.';

-- Change only the facts and newest-mark expressions; preserve every other field,
-- setting and grant.
-- Refuse an unfamiliar body rather than replacing a sibling change wholesale.
DO $patch$
DECLARE
  definition text := pg_get_functiondef('public.context_worker_state()'::regprocedure);
  old_expression text := 'CASE WHEN EXISTS (SELECT 1 FROM public.context_extraction_candidates(1)) THEN 1 ELSE 0 END';
  new_expression text := 'public.context_worker_facts_present()';
  old_marks text := '(SELECT max(m.last_marked_at) FROM public.job_change_marks m)';
  new_marks text := 'public.context_worker_marks_newest()'; BEGIN
  IF (position(old_expression IN definition) = 0 AND position(new_expression IN definition) = 0)
    OR (position(old_marks IN definition) = 0 AND position(new_marks IN definition) = 0) THEN
    RAISE EXCEPTION 'worker state follow-up: facts pre-image changed';
  END IF;
  EXECUTE replace(replace(definition, old_expression, new_expression), old_marks, new_marks);
END $patch$;
