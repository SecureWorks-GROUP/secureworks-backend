-- Down migration for 20261002170000_context_source_admission.
--
-- Restores context_unread_rows to K1's body (20260924030000) and
-- context_catchup_eligible_rows to the catch-up body (20260924220000), byte
-- for byte (md5 checked at the end), and drops context_event_source_admissible.
-- No row is written. After this rollback the batch reader again hands out rows
-- the revision store refuses (the daily revision_store_unavailable failures
-- return for jobs holding such rows). Drop the repair
-- (20261002170100_context_payload_job_repair_down.sql) first: it requires the
-- admission rule.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
 IF to_regprocedure('public.context_payload_job_repair(boolean,integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'source admission rollback: roll back 20261002170100 (context_payload_job_repair) first'; END IF;
END $$;

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

CREATE OR REPLACE FUNCTION public.context_catchup_eligible_rows(p_job_ids uuid[]) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.* FROM public.business_events e
 WHERE e.job_id=ANY(p_job_ids)
  AND public.context_linked_status(e.attribution_status)
  AND e.context_captured_at IS NOT NULL
  AND coalesce(e.metadata->>'written_as','service_role')='service_role'
  AND btrim(public.context_event_text(e))<>''
$$;
COMMENT ON FUNCTION public.context_catchup_eligible_rows(uuid[]) IS
 'Catch-up: readable, placed, worded business events eligible for a full read. Service role only.';

DROP FUNCTION IF EXISTS public.context_event_source_admissible(public.business_events);

REVOKE ALL ON FUNCTION public.context_unread_rows(uuid[]),public.context_catchup_eligible_rows(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_unread_rows(uuid[]),public.context_catchup_eligible_rows(uuid[]) TO service_role;

DO $$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure('public.context_unread_rows(uuid[])');
 IF live IS DISTINCT FROM 'd426adcccab139a188ee158e14ca4fb1' THEN RAISE EXCEPTION 'source admission rollback: context_unread_rows body is %',live; END IF;
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure('public.context_catchup_eligible_rows(uuid[])');
 IF live IS DISTINCT FROM 'd028f0366b62e828b43edb7bd650828b' THEN RAISE EXCEPTION 'source admission rollback: context_catchup_eligible_rows body is %',live; END IF;
END $$;
