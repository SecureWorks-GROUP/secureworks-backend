SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE source_hash text;
/* pre-image guard */ BEGIN
  SELECT md5(prosrc) INTO source_hash FROM pg_proc
    WHERE oid = 'public.context_worker_facts_present()'::regprocedure;
  IF source_hash NOT IN ('7f24a25111c4c58004dca7f4c401c931', 'b54f07cf53aa8d120bb63120e88d369f') THEN
    RAISE EXCEPTION 'worker facts due: helper pre-image changed';
  END IF;
END $guard$;

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
COMMENT ON FUNCTION public.context_worker_facts_present() IS
  'P0-03.1 work-present signal, not a count or due verdict. Lane off = 0; lane on = 1 for a live-capture candidate since live_since or unfinished catch-up. Includes read or blocked work, never authorises extraction. Two indexed existence probes, no cadence pool, receipts or payload read.';
DROP INDEX IF EXISTS public.business_events_worker_facts_jobs;
