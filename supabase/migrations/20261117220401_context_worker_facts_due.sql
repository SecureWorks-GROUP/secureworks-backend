-- FU20 part 1: facts is an existence verdict from the extraction selector's
-- own context_jobs_cadence judge, not the presence of historical evidence.
-- Replaces only the helper. context_worker_state, including the mark reads and
-- the separately reviewed fact-read switch, stays byte-for-byte unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE source_hash text;
/* pre-image guard */ BEGIN
  SELECT md5(prosrc) INTO source_hash FROM pg_proc
    WHERE oid = 'public.context_worker_facts_present()'::regprocedure;
  IF source_hash NOT IN ('b54f07cf53aa8d120bb63120e88d369f', '05b9e4b3258cef32f9607d1ae548b720') THEN
    RAISE EXCEPTION 'worker facts due: helper pre-image changed';
  END IF;
END $guard$;

-- Stream live candidate job ids without sorting the evidence heap. The partial
-- predicate matches context_cadence_pool; the capture floor remains a runtime
-- index condition. No growing queue, trigger, schedule, switch or row write.
CREATE INDEX IF NOT EXISTS business_events_worker_facts_jobs
  ON public.business_events (job_id, context_captured_at)
  WHERE job_id IS NOT NULL
    AND metadata->>'written_as' = 'service_role'
    AND coalesce(metadata->>'capture_mode', 'live') = 'live';
COMMENT ON INDEX public.business_events_worker_facts_jobs IS
  'FU20 part 1: ordered live candidate jobs for a LIMIT 1 due probe; context_unread_rows handles admission and receipts, context_jobs_cadence handles due. Empty due work may traverse the unread pool.';

CREATE OR REPLACE FUNCTION public.context_worker_facts_present() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT CASE WHEN NOT public.automation_lane_enabled('extraction') THEN 0
    WHEN EXISTS (
      -- The live half of context_cadence_pool, streamed in job-id index order.
      -- context_unread_rows owns receipt, text and source admission; the shared
      -- judge owns every due rule. Never cap candidate jobs before judging them.
      SELECT 1 FROM (
        SELECT DISTINCT u.job_id FROM public.context_unread_rows(NULL) u
        WHERE u.context_captured_at >= (public.context_cadence_policy()->>'live_since')::timestamptz
          AND coalesce(u.metadata->>'capture_mode', 'live') = 'live'
          AND u.metadata->>'written_as' = 'service_role'
        ORDER BY u.job_id
      ) candidate
      CROSS JOIN LATERAL public.context_jobs_cadence(ARRAY[candidate.job_id]) judged
      WHERE (judged.cadence->>'due')::boolean
      LIMIT 1
    ) OR EXISTS (
      -- Keep the index-ordered candidate stream inside a subquery: EXISTS
      -- discards a top-level ORDER BY before choosing its access path.
      SELECT 1 FROM (
        SELECT c.job_id FROM public.context_catchup_jobs c
        WHERE c.done_at IS NULL
        ORDER BY c.job_id
      ) candidate
      CROSS JOIN LATERAL public.context_jobs_cadence(ARRAY[candidate.job_id]) judged
      WHERE (judged.cadence->>'due')::boolean
      LIMIT 1
    ) THEN 1 ELSE 0 END
$fn$;
REVOKE ALL ON FUNCTION public.context_worker_facts_present() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_worker_facts_present() TO service_role;
COMMENT ON FUNCTION public.context_worker_facts_present() IS
  'FU20 part 1: 0 or 1 for any job due now by context_jobs_cadence, the extraction selector judge. Same live unread and unfinished catch-up pool; two LIMIT 1 probes, no candidate cap or all-job array. Extraction lane off = 0. Read failures propagate, never become empty work.';
