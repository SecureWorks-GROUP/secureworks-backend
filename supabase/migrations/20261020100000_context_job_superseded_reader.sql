-- Job superseded reader (CTX-T16b slice 1): one read-only answer to "was this
-- job superseded (not live) at that instant?", read from the job_events log
-- alone.
--
-- What, all additive:
--   1. public.context_job_superseded_during(p_job uuid, p_at timestamptz)
--      RETURNS boolean. LANGUAGE sql, STABLE, SECURITY INVOKER, no SET clause
--      (so the planner may inline it), every name schema-qualified.
--   2. feature_flags.context_job_superseded_reader_v1, created OFF. No
--      consumer reads it yet; slice 2 gates its wiring on it. The reader
--      itself never reads the flag.
--
-- The rule (SQ-23, 20261019210000_fence_quote_option_jobs.sql at ba5cc25,
-- header lines 18 to 20): a job is not live from each
-- quote_option_superseded event to the next quote_option_unsuperseded event
-- for it, and live outside those. This migration does not copy or depend on
-- SQ-23: it reads two event_type values of public.job_events and nothing else.
--
-- Read: public.job_events rows with this job_id and event_type
-- quote_option_superseded or quote_option_unsuperseded, created_at not null.
-- Never read: jobs.status, jobs.superseded_at, jobs.superseded_by_job_id,
-- quote_acceptance_gaps or any SQ-23 flag.
--
-- Edge semantics (the answer is read from the events at the newest instant,
-- created_at, at or before p_at):
--   - An event exactly at p_at has happened at p_at (created_at <= p_at). A
--     superseded event at p_at makes p_at superseded; an unsuperseded event
--     at p_at makes p_at live. Each interval is [superseded, unsuperseded).
--   - An unpaired unsuperseded (no open interval before it) changes nothing:
--     the job was live and stays live.
--   - Two superseded events in a row: the second changes nothing; the
--     interval stays open from the first until the next unsuperseded.
--   - S1-M1, opposite-type tie: when the newest instant at or before p_at
--     holds both a superseded and an unsuperseded event for the job, the
--     answer is null (unknown). One is never picked. SQ-23 writes exactly this
--     shape: when a job leaves a won status, its trigger can clear an option's
--     mark (quote_option_unsuperseded) and then, with exactly one option still
--     won, supersede it again (quote_option_superseded) in one transaction, so
--     both rows carry the same now(). The true state there is superseded, but
--     job_events.id is a random uuid, so no id order can tell; the old id
--     tiebreak read live about half the time.
--   - A same-type tie at the newest instant (two superseded, or two
--     unsuperseded) answers by that type.
--   - An opposite-type tie at an earlier instant matters only while it is the
--     newest instant at or before p_at: once a later event exists at or
--     before p_at, that later instant alone decides. So a job superseded at
--     t0 and then cleared and re-superseded in one transaction at t1 reads
--     true for t0 <= p_at < t1 and null for p_at >= t1 until a later event.
--   - No such event at or before p_at: false (live).
--   - p_job or p_at null: null (unknown), never false.
--   - A row with created_at null has no instant and is not read.
--   - job_events.id is no longer an input: with ties answered by the set of
--     types at the instant, there is no text sort or tiebreak to collate.
--
-- Named limit S1-L1 writer_time_is_transaction_start: the SQ-23 writers take
-- the default created_at, which is now(), the transaction start. A writer
-- that waited on the group's advisory lock can therefore carry an earlier
-- created_at than a write that committed before it, so order across
-- transactions can invert. This reader cannot see that. The causal fix
-- (clock_timestamp() or a sequence on the writers) belongs to the SQ-23
-- owner; SQ-23 is not touched here.
--
-- Named limit status_without_event_not_detected_needs_gap_grant: the CTX-T16b
-- reader rule also says a status change with no event (status_without_event)
-- is "chronology unknown" and its items are held O?. This reader CANNOT
-- detect that case: detecting it needs the quote_acceptance_gaps view, whose
-- grant is held for the owner, and reading jobs.status instead is forbidden.
-- So false here means only "no superseded interval in the events", never "no
-- gap". The function returns only what events show.
--
-- No existing function body is changed and nothing calls this reader:
-- context_contact_jobs_at, context_lead_monitored_jobs and the judge's live
-- set are untouched, so no ladder md5 pin moves. Grants: revoked from PUBLIC,
-- anon and authenticated; execute for service_role only.

-- 1. Pre-image guard: the inputs exist, and the name is absent or ours.
DO $guard$
DECLARE
 problems text[] := ARRAY[]::text[];
 c text;
 x record;
BEGIN
 IF to_regclass('public.job_events') IS NULL THEN
  problems := problems || 'public.job_events missing'::text;
 ELSE
  FOREACH c IN ARRAY ARRAY['id', 'job_id', 'event_type', 'created_at'] LOOP
   IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = 'public.job_events'::regclass
                     AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped) THEN
    problems := problems || format('job_events.%s missing', c);
   END IF;
  END LOOP;
 END IF;
 IF to_regclass('public.feature_flags') IS NULL THEN
  problems := problems || 'public.feature_flags missing'::text;
 ELSIF EXISTS (SELECT 1 FROM public.feature_flags
                WHERE flag_name = 'context_job_superseded_reader_v1' AND enabled IS TRUE) THEN
  problems := problems || 'feature flag context_job_superseded_reader_v1 is already on before the first apply'::text;
 END IF;
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS cmt
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'context_job_superseded_during' LOOP
  IF x.sig <> 'context_job_superseded_during(uuid,timestamp with time zone)'
     OR x.cmt NOT LIKE 'Job superseded reader (20261020100000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_job_superseded_reader_refused: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 2. The reader.
CREATE OR REPLACE FUNCTION public.context_job_superseded_during(p_job uuid, p_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
PARALLEL SAFE
AS $fn$
 SELECT CASE
  WHEN p_job IS NULL OR p_at IS NULL THEN NULL::boolean
  ELSE (
   -- The events at the newest instant at or before p_at. None: live (false).
   -- Only superseded: true. Only unsuperseded: false. Both (S1-M1): null.
   -- Every operator and aggregate is schema-qualified (no SET search_path).
   SELECT CASE
           WHEN pg_catalog.count(*) OPERATOR(pg_catalog.=) 0 THEN false
           WHEN pg_catalog.bool_and(e.event_type OPERATOR(pg_catalog.=) 'quote_option_superseded') THEN true
           WHEN pg_catalog.bool_and(e.event_type OPERATOR(pg_catalog.=) 'quote_option_unsuperseded') THEN false
           ELSE NULL::boolean
          END
     FROM public.job_events e
    WHERE e.job_id OPERATOR(pg_catalog.=) p_job
      AND e.event_type OPERATOR(pg_catalog.=) ANY (ARRAY['quote_option_superseded', 'quote_option_unsuperseded']::text[])
      AND e.created_at OPERATOR(pg_catalog.=) (
       SELECT pg_catalog.max(m.created_at)
         FROM public.job_events m
        WHERE m.job_id OPERATOR(pg_catalog.=) p_job
          AND m.event_type OPERATOR(pg_catalog.=) ANY (ARRAY['quote_option_superseded', 'quote_option_unsuperseded']::text[])
          AND m.created_at OPERATOR(pg_catalog.<=) p_at))
 END
$fn$;

COMMENT ON FUNCTION public.context_job_superseded_during(uuid, timestamptz) IS
'Job superseded reader (20261020100000): true when the job was superseded (not live) at p_at by the job_events log alone, read from the quote_option_superseded and quote_option_unsuperseded events for the job at the newest created_at at or before p_at: only superseded is true, only unsuperseded is false, none is false. An event at p_at counts; an unpaired unsuperseded and a repeated superseded change nothing; a same-type tie answers by its type; null job or instant is null. S1-M1: an opposite-type tie at that newest instant (a clear and a re-supersede in one transaction share now()) is null (unknown), never picked; an earlier tie matters only while it is the newest instant at or before p_at. Never reads jobs.status, jobs.superseded_at, jobs.superseded_by_job_id or quote_acceptance_gaps. Named limits: status_without_event_not_detected_needs_gap_grant (a status change with no event is not seen, so false is never "no gap"); S1-L1 writer_time_is_transaction_start (created_at is the writer''s transaction start, so order across transactions can invert unseen; the causal fix belongs to the SQ-23 owner). No consumer yet; slice 2 gates on feature_flags.context_job_superseded_reader_v1. Service role only.';

REVOKE ALL ON FUNCTION public.context_job_superseded_during(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_superseded_during(uuid, timestamptz) TO service_role;

-- 3. The switch, created off. Nothing reads it yet.
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'context_job_superseded_reader_v1', false,
 'Job superseded reader (20261020100000, CTX-T16b): while on, slice 2 consumers may treat a job as not live while public.context_job_superseded_during(job, at) is true. No consumer reads this flag yet; the reader itself never reads it. Owner''s word to turn on.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_job_superseded_reader_v1');

-- 4. Proof in the same transaction.
DO $verify$
DECLARE f record;
BEGIN
 SELECT p.provolatile, p.prosecdef, p.proconfig, p.prolang INTO f
   FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_superseded_during(uuid,timestamp with time zone)');
 IF NOT FOUND THEN
  RAISE EXCEPTION 'context_job_superseded_reader_verify: reader missing';
 END IF;
 IF f.provolatile <> 's' OR f.prosecdef OR f.proconfig IS NOT NULL THEN
  RAISE EXCEPTION 'context_job_superseded_reader_verify: reader must be STABLE, SECURITY INVOKER, with no SET clause';
 END IF;
 IF has_function_privilege('anon', 'public.context_job_superseded_during(uuid,timestamp with time zone)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_job_superseded_during(uuid,timestamp with time zone)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.context_job_superseded_during(uuid,timestamp with time zone)', 'EXECUTE') THEN
  RAISE EXCEPTION 'context_job_superseded_reader_verify: execute must be service_role only';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_job_superseded_reader_v1') THEN
  RAISE EXCEPTION 'context_job_superseded_reader_verify: flag row missing';
 END IF;
END $verify$;
