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

CREATE INDEX IF NOT EXISTS job_change_marks_newest
  ON public.job_change_marks (last_marked_at DESC);

COMMENT ON INDEX public.business_events_worker_facts_present IS
  'P0-03.1 conservative worker wake: seek live_since, stop at the first placed service-role live-capture candidate, without reading payloads or judging jobs.';
COMMENT ON INDEX public.context_catchup_jobs_worker_present IS
  'P0-03.1 conservative worker wake: first unfinished catch-up request, including blocked requests.';
COMMENT ON INDEX public.job_change_marks_newest IS
  'P0-03.1 newest mark across all jobs, including fully acknowledged marks; serves max(last_marked_at).';

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

-- Change only the facts expression; preserve every other field, setting and grant.
-- Refuse an unfamiliar body rather than replacing a sibling change wholesale.
DO $patch$
DECLARE
  definition text := pg_get_functiondef('public.context_worker_state()'::regprocedure);
  old_expression text := 'CASE WHEN EXISTS (SELECT 1 FROM public.context_extraction_candidates(1)) THEN 1 ELSE 0 END';
  new_expression text := 'public.context_worker_facts_present()'; BEGIN
  IF position(old_expression IN definition) > 0 THEN
    EXECUTE replace(definition, old_expression, new_expression);
  ELSIF position(new_expression IN definition) = 0 THEN
    RAISE EXCEPTION 'worker state follow-up: facts pre-image changed';
  END IF;
END $patch$;
