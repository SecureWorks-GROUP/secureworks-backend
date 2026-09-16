-- Restore the extraction scope functions exactly as 20260911171000 defined them and
-- drop the extractable predicate. No data is touched.
-- An unreceipted fresh capture activates history for that job without mass historical extraction.
CREATE OR REPLACE FUNCTION public.context_extraction_events(p_job_id uuid,p_limit integer DEFAULT 25) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH eligible AS (
 SELECT e.* FROM public.business_events e WHERE public.automation_lane_enabled('extraction') AND e.job_id=p_job_id
 AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND btrim(public.context_event_text(e))<>''
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=p_job_id AND r.extractor_version='luna_v2')
 AND EXISTS(SELECT 1 FROM public.business_events fresh WHERE fresh.job_id=p_job_id AND fresh.context_captured_at IS NOT NULL
  AND fresh.attribution_status IN ('direct','thread','single_open','single_line','luna') AND fresh.direction IS DISTINCT FROM 'outbound')
 ), anchor AS (
 SELECT e.* FROM public.business_events e WHERE e.job_id=p_job_id
 AND e.direction IS DISTINCT FROM 'outbound' AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND btrim(public.context_event_text(e))<>''
 ORDER BY CASE WHEN EXISTS(SELECT 1 FROM eligible u WHERE u.id=e.id) THEN 0 ELSE 1 END,coalesce(e.event_at,e.occurred_at),e.id LIMIT 1
 ), combined AS (
 SELECT * FROM eligible UNION SELECT * FROM anchor WHERE EXISTS(SELECT 1 FROM eligible)
 ), selected AS (
 SELECT e.* FROM combined e WHERE EXISTS(SELECT 1 FROM anchor)
 ORDER BY CASE WHEN e.id=(SELECT id FROM anchor) THEN 0 ELSE 1 END,coalesce(e.event_at,e.occurred_at),e.id
 LIMIT greatest(0,least(coalesce(p_limit,25),25))
 ) SELECT * FROM selected ORDER BY coalesce(event_at,occurred_at),id
$$;
CREATE OR REPLACE FUNCTION public.context_extraction_candidates(p_limit integer DEFAULT 400) RETURNS TABLE(job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.job_id FROM public.business_events e WHERE public.automation_lane_enabled('extraction') AND e.job_id IS NOT NULL
 AND btrim(public.context_event_text(e))<>''
 AND EXISTS(SELECT 1 FROM public.business_events fresh WHERE fresh.job_id=e.job_id AND fresh.context_captured_at IS NOT NULL AND fresh.attribution_status IN ('direct','thread','single_open','single_line','luna') AND fresh.direction IS DISTINCT FROM 'outbound')
 AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_runs r WHERE r.job_id=e.job_id AND r.run_date=(now() AT TIME ZONE 'Australia/Perth')::date AND r.phase='extraction' AND r.status IN ('done','skipped'))
 GROUP BY e.job_id ORDER BY EXISTS(SELECT 1 FROM public.context_extraction_runs retry WHERE retry.job_id=e.job_id AND retry.run_date=(now() AT TIME ZONE 'Australia/Perth')::date AND retry.phase='extraction' AND retry.status IN ('running','failed')) DESC,min(coalesce(e.event_at,e.occurred_at)),e.job_id LIMIT greatest(0,least(coalesce(p_limit,400),400))
$$;
DROP FUNCTION IF EXISTS public.context_job_extractable(public.jobs);
