-- Ship the history-door copy check but not the reader skip: the admission rule
-- goes back to 20261002170000's body, so a marked copy would be read again.
-- The contract must catch it.
CREATE OR REPLACE FUNCTION public.context_event_source_admissible(e public.business_events) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT coalesce(
  e.job_id IS NOT NULL
  AND e.attribution_status IS NOT NULL AND public.context_linked_status(e.attribution_status)
  AND (e.payload OPERATOR(pg_catalog.#>>) '{job_id}'::pg_catalog.text[] IS NULL
   OR e.payload OPERATOR(pg_catalog.#>>) '{job_id}'::pg_catalog.text[] OPERATOR(pg_catalog.=) e.job_id::pg_catalog.text)
  AND coalesce(e.event_at,e.occurred_at) IS NOT NULL
  AND e.attribution_confidence IS NOT NULL
  AND e.attribution_confidence OPERATOR(pg_catalog.>=) 0 AND e.attribution_confidence OPERATOR(pg_catalog.<=) 1
  AND e.metadata OPERATOR(pg_catalog.#>>) '{retracted_at}'::pg_catalog.text[] IS NULL
  AND (e.metadata OPERATOR(pg_catalog.#>>) '{retracted}'::pg_catalog.text[] IS NULL
   OR e.metadata OPERATOR(pg_catalog.#>>) '{retracted}'::pg_catalog.text[] OPERATOR(pg_catalog.<>) 'true'),
 false)
$$;
