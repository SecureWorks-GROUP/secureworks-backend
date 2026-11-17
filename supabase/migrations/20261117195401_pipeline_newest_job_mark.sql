-- FU13: read the live append-only job-page marks, not their aggregate view.
-- Definitions and index only. No trigger, schedule, switch or business write.
SET LOCAL lock_timeout = '5s';

-- Full index: handled marks still count until the existing bounded fold removes
-- them. The partial page-pending index cannot answer the board stamp.
CREATE INDEX IF NOT EXISTS job_change_mark_events_newest
 ON public.job_change_mark_events(marked_at DESC) INCLUDE (job_id);

CREATE OR REPLACE FUNCTION public.pipeline_newest_job_mark(p_org_id uuid)
RETURNS TABLE(last_marked_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER AS $fn$
 SELECT e.marked_at AS last_marked_at
 FROM public.job_change_mark_events e
 WHERE EXISTS (
  SELECT 1 FROM public.jobs j WHERE j.id=e.job_id AND j.org_id=p_org_id
 )
 ORDER BY e.marked_at DESC
 LIMIT 1
$fn$;
REVOKE ALL ON FUNCTION public.pipeline_newest_job_mark(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pipeline_newest_job_mark(uuid) TO service_role;
COMMENT ON FUNCTION public.pipeline_newest_job_mark(uuid) IS
 'FU13: newest live job-page mark for one org; job_change_mark_events_newest and jobs_pkey. Read only.';
