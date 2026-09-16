-- D4: keep the daily model budget for real jobs (audit 2026-09-16, target 1b and 3b).
-- Measured live: the archived holding job SWF-PDF-BUCKET took 50 of 124 extraction
-- calls on 15 and 16 Sep for 2 facts, and 17 of 55 current Luna facts came from our
-- own outbound messages. Target 1b: sent items are read only alongside the client's
-- messages, never extracted alone. Target 3: archived jobs are not rechecked.
--
-- Same names and signatures as 20260911171000 (CREATE OR REPLACE, re-runnable).
-- The daily cap and reservation functions are untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A job takes model budget only when it is a real, non-archived job. Holding jobs are
-- the rows an agent minted to park unallocated documents: they carry
-- metadata.do_not_schedule = true (SWF-PDF-BUCKET, purpose pdf_unlock_bucket), no
-- contact and an internal site. That marker, not the job number, is the rule.
CREATE OR REPLACE FUNCTION public.context_job_extractable(j public.jobs) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT j.id IS NOT NULL
  AND j.status::text IS DISTINCT FROM 'archived'
  AND coalesce(to_jsonb(j)->'metadata'->>'do_not_schedule','') NOT IN ('true','1')
$$;
REVOKE ALL ON FUNCTION public.context_job_extractable(public.jobs) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_extractable(public.jobs) TO service_role;

-- Outbound rows ride along as context only when the same job has unreceipted inbound
-- or internal evidence. A job whose only new evidence is our own messages never runs.
CREATE OR REPLACE FUNCTION public.context_extraction_events(p_job_id uuid,p_limit integer DEFAULT 25) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH admitted AS (
 SELECT public.automation_lane_enabled('extraction')
  AND EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=p_job_id AND public.context_job_extractable(j))
  AND EXISTS(SELECT 1 FROM public.business_events fresh WHERE fresh.job_id=p_job_id AND fresh.context_captured_at IS NOT NULL
   AND fresh.attribution_status IN ('direct','thread','single_open','single_line','luna') AND fresh.direction IS DISTINCT FROM 'outbound') AS ok
 ), unreceipted AS (
 SELECT e.* FROM public.business_events e WHERE (SELECT ok FROM admitted) AND e.job_id=p_job_id
 AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND btrim(public.context_event_text(e))<>''
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=p_job_id AND r.extractor_version='luna_v2')
 ), eligible AS (
 SELECT u.* FROM unreceipted u WHERE EXISTS(SELECT 1 FROM unreceipted i WHERE i.direction IS DISTINCT FROM 'outbound')
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

-- A job is a candidate only on unreceipted non-outbound evidence, and only while it is
-- extractable. Ordering, the per-day done/skipped guard and the 400 limit are unchanged.
CREATE OR REPLACE FUNCTION public.context_extraction_candidates(p_limit integer DEFAULT 400) RETURNS TABLE(job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.job_id FROM public.business_events e JOIN public.jobs j ON j.id=e.job_id
 WHERE public.automation_lane_enabled('extraction') AND e.job_id IS NOT NULL AND public.context_job_extractable(j)
 AND e.direction IS DISTINCT FROM 'outbound'
 AND btrim(public.context_event_text(e))<>''
 AND EXISTS(SELECT 1 FROM public.business_events fresh WHERE fresh.job_id=e.job_id AND fresh.context_captured_at IS NOT NULL AND fresh.attribution_status IN ('direct','thread','single_open','single_line','luna') AND fresh.direction IS DISTINCT FROM 'outbound')
 AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_runs r WHERE r.job_id=e.job_id AND r.run_date=(now() AT TIME ZONE 'Australia/Perth')::date AND r.phase='extraction' AND r.status IN ('done','skipped'))
 GROUP BY e.job_id ORDER BY EXISTS(SELECT 1 FROM public.context_extraction_runs retry WHERE retry.job_id=e.job_id AND retry.run_date=(now() AT TIME ZONE 'Australia/Perth')::date AND retry.phase='extraction' AND retry.status IN ('running','failed')) DESC,min(coalesce(e.event_at,e.occurred_at)),e.job_id LIMIT greatest(0,least(coalesce(p_limit,400),400))
$$;
REVOKE ALL ON FUNCTION public.context_extraction_events(uuid,integer),public.context_extraction_candidates(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_extraction_events(uuid,integer),public.context_extraction_candidates(integer) TO service_role;
