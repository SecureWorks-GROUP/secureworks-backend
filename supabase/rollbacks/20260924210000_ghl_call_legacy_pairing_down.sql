SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS business_events_pair_legacy_call ON public.business_events;
DROP FUNCTION IF EXISTS public.pair_legacy_ghl_call();
DROP INDEX IF EXISTS public.business_events_legacy_call_pair_lookup;

CREATE OR REPLACE FUNCTION public.context_unread_rows(p_job_ids uuid[]) RETURNS SETOF public.business_events
LANGUAGE sql STABLE AS $$
 SELECT e.* FROM public.business_events e
 WHERE e.job_id IS NOT NULL AND (p_job_ids IS NULL OR e.job_id OPERATOR(pg_catalog.=) ANY(p_job_ids))
  AND public.context_linked_status(e.attribution_status)
  AND e.context_captured_at IS NOT NULL
  AND coalesce(e.metadata OPERATOR(pg_catalog.->>) 'written_as','service_role') OPERATOR(pg_catalog.=) 'service_role'
  AND pg_catalog.btrim(public.context_event_text(e)) OPERATOR(pg_catalog.<>) ''
  AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r
   WHERE r.event_id OPERATOR(pg_catalog.=) e.id AND r.job_id OPERATOR(pg_catalog.=) e.job_id
    AND r.extractor_version OPERATOR(pg_catalog.=) 'luna_v2')
$$;
