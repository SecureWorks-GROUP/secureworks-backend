-- The batch reader hands out only rows the revision store will accept.
--
-- Three jobs failed the daily context read every day from 23 and 25 Sep 2026
-- (revision_store_unavailable, three attempts each). A read-only production
-- read on 2 Oct 2026 found the cause: context_extraction_events gave the
-- worker rows that persist_luna_context_revision (B3, 20260924220000) then
-- refused with luna_source_attribution_rejected, every one of them because the
-- row sits on the job being read while its payload.job_id names another job
-- (26 of the 44 batch rows on those jobs; statuses luna and single_open). One
-- refused row fails the whole revision, so the job never finishes a read and
-- comes back due the next day.
--
-- The two sides disagree about who may read a row. The readers (the one
-- unread definition context_unread_rows, and the catch-up set
-- context_catchup_eligible_rows) admit any linked, captured, worded,
-- service-written row on the job. B3 additionally refuses, row by row, a
-- source whose payload names a different job, one with no source time, one
-- with no attribution confidence in [0,1], and one marked retracted. This
-- migration writes B3's per-row rule once, as context_event_source_admissible,
-- and both readers apply it, so:
--   * context_extraction_events never returns a row B3 refuses;
--   * cadence (context_jobs_cadence, the pool, candidates, status) stops
--     counting such a row as unread, so it never makes a job due on its own;
--   * catch-up pending rows leave it out, so a listed job can finish and
--     context_catchup_mark_done can fire.
-- A refused row is left exactly where it is: nothing is written, deleted or
-- moved here. Correcting misplaced rows is the separate, dry-run-by-default
-- repair in 20261002170100_context_payload_job_repair.sql.
--
-- B3 itself is not replaced: its check stays as the last line of defence, and
-- the contract proves the reader and B3 agree on every refused shape.
-- The helper reads typed columns only (no to_jsonb of the row) and carries no
-- SET clause, so context_unread_rows stays inlinable. business_events has no
-- retracted_at or retracted column (20260924020000 guards that), so B3's
-- column-level retraction terms are always null and only the metadata terms
-- apply.
--
-- Built on the repository bodies of 20260924030000 (context_unread_rows) and
-- 20260924220000 (context_catchup_eligible_rows); the guard refuses unless
-- each is still that body (or already this migration's, for a re-apply).
-- Rollback: supabase/rollbacks/20261002170000_context_source_admission_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_unread_rows(uuid[])',ARRAY['d426adcccab139a188ee158e14ca4fb1','bb5ec9f11d525b8d420739fa3d8c4d54'],false),
  ('public.context_catchup_eligible_rows(uuid[])',ARRAY['d028f0366b62e828b43edb7bd650828b','f4ee5a7b0161d4e8aae729c35b86d7ed'],false),
  ('public.context_event_source_admissible(public.business_events)',ARRAY['fefd29131583c8e2afef18eca885b4d7'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.business_events'::regclass AND a.attname IN ('retracted_at','retracted')
   AND a.attnum>0 AND NOT a.attisdropped)
 THEN problems:=problems||'business_events has a retracted_at or retracted column; context_event_source_admissible reads only metadata for retraction'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_source_admission_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. B3's per-row rule, once. p_job_id in B3 is the row's own job here,
-- because both readers select rows by job.
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
COMMENT ON FUNCTION public.context_event_source_admissible(public.business_events) IS
 'True when persist_luna_context_revision would accept this row as a source for its own job: linked status, payload.job_id absent or equal to job_id (exact text), a source time, an attribution confidence in [0,1], not retracted in metadata. The one admission rule both batch readers apply (20261002170000). Service role only.';

-- 2. The one unread definition: K1's body plus the admission rule.
CREATE OR REPLACE FUNCTION public.context_unread_rows(p_job_ids uuid[]) RETURNS SETOF public.business_events
LANGUAGE sql STABLE AS $$
 SELECT e.* FROM public.business_events e
 WHERE e.job_id IS NOT NULL AND (p_job_ids IS NULL OR e.job_id OPERATOR(pg_catalog.=) ANY(p_job_ids))
  AND public.context_linked_status(e.attribution_status)
  AND e.context_captured_at IS NOT NULL
  AND coalesce(e.metadata OPERATOR(pg_catalog.->>) 'written_as','service_role') OPERATOR(pg_catalog.=) 'service_role'
  AND pg_catalog.btrim(public.context_event_text(e)) OPERATOR(pg_catalog.<>) ''
  AND public.context_event_source_admissible(e)
  AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r
   WHERE r.event_id OPERATOR(pg_catalog.=) e.id AND r.job_id OPERATOR(pg_catalog.=) e.job_id
    AND r.extractor_version OPERATOR(pg_catalog.=) 'luna_v2')
$$;

-- 3. The catch-up set: 20260924220000's body plus the admission rule.
CREATE OR REPLACE FUNCTION public.context_catchup_eligible_rows(p_job_ids uuid[]) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.* FROM public.business_events e
 WHERE e.job_id=ANY(p_job_ids)
  AND public.context_linked_status(e.attribution_status)
  AND e.context_captured_at IS NOT NULL
  AND coalesce(e.metadata->>'written_as','service_role')='service_role'
  AND btrim(public.context_event_text(e))<>''
  AND public.context_event_source_admissible(e)
$$;
COMMENT ON FUNCTION public.context_catchup_eligible_rows(uuid[]) IS
 'Catch-up: readable, placed, worded business events eligible for a full read, minus rows the revision store refuses (context_event_source_admissible, 20261002170000). Service role only.';

-- 4. Grants: service role only, as before.
REVOKE ALL ON FUNCTION public.context_event_source_admissible(public.business_events),
 public.context_unread_rows(uuid[]),public.context_catchup_eligible_rows(uuid[])
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_event_source_admissible(public.business_events),
 public.context_unread_rows(uuid[]),public.context_catchup_eligible_rows(uuid[])
TO service_role;
