-- Undo for scripts/context-bucket-rerun-l1g.sql (7 Oct 2026).
--
-- Puts back, on every row the re-run touched (metadata.bucket_rerun.run =
-- context_bucket_rerun_l1g_20261007), every column it wrote exactly as it was
-- (saved in metadata.bucket_rerun.prior): job, contact, attribution and match
-- columns, candidates, event_at, the whole metadata object (party roles, the
-- relink stamp of a placed row and the copy marks of a marked copy included)
-- and the two payload keys the ladder may touch. A row the re-run kept (a copy
-- it marked, a row Luna had answered) gets its metadata back the same way; its
-- columns never moved. Then it removes
-- each thread binding a re-run decision made (bucket_rerun.bound, only while it
-- is still that row's live binding to the job the re-run gave it) and clears
-- the retirement of each binding a decision retired (bucket_rerun.retired, only
-- while its retired_at is still the recorded one). No other row or binding is
-- touched.
--
-- It refuses when a re-run row changed after the re-run (its job or status is
-- no longer what the re-run wrote, bucket_rerun.after: Luna answered it, a
-- person placed it, P1b reopened it), so a later decision is never silently
-- overwritten. The party roles trigger is disabled for this transaction only
-- (a short lock on business_events) so the saved stamp is restored exactly,
-- and enabled again before it ends.
--
-- How to run (production: a write only with the owner's go). As written it
-- ends in ROLLBACK: a dry run. First read the count:
--   BEGIN READ ONLY;
--   SELECT count(*) FROM public.business_events
--    WHERE metadata->'bucket_rerun'->>'run' = 'context_bucket_rerun_l1g_20261007';
--   ROLLBACK;
-- put it in expected_rows below, run this file, then (owner's go) change the
-- final ROLLBACK to COMMIT and run it once.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '600s';

CREATE TEMP TABLE rr_undo ON COMMIT DROP AS
SELECT e.id, e.job_id, e.attribution_status, e.metadata, e.metadata->'bucket_rerun' AS rr
FROM public.business_events e
WHERE e.metadata->'bucket_rerun'->>'run' = 'context_bucket_rerun_l1g_20261007'
FOR UPDATE OF e;

CREATE TEMP TABLE rr_undo_bound ON COMMIT DROP AS
SELECT u.id, k.value #>> '{}' AS thread_key, (u.rr->'after'->>'job_id')::uuid AS job_id
FROM rr_undo u, jsonb_array_elements(coalesce(u.rr->'bound', '[]'::jsonb)) k;

CREATE TEMP TABLE rr_undo_retired ON COMMIT DROP AS
SELECT u.id, k.value->>'key' AS thread_key, (k.value->>'retired_at')::timestamptz AS retired_at
FROM rr_undo u, jsonb_array_elements(coalesce(u.rr->'retired', '[]'::jsonb)) k;

DO $undo$
DECLARE
 -- The number of rows the re-run committed, summed over its batches (count first, as above).
 expected_rows constant integer := 0;
 n integer; restored integer; has_trigger boolean;
BEGIN
 SELECT count(*) INTO n FROM rr_undo;
 IF n <> expected_rows THEN
  RAISE EXCEPTION 'bucket_rerun_l1g undo: % rows carry this run''s stamp, expected %; refusing', n, expected_rows;
 END IF;
 IF EXISTS (SELECT 1 FROM rr_undo u WHERE jsonb_typeof(u.rr->'prior'->'metadata') IS DISTINCT FROM 'object') THEN
  RAISE EXCEPTION 'bucket_rerun_l1g undo: a touched row has no saved prior; refusing';
 END IF;
 SELECT count(*) INTO n FROM rr_undo u
 WHERE u.job_id IS DISTINCT FROM (u.rr->'after'->>'job_id')::uuid
    OR u.attribution_status IS DISTINCT FROM u.rr->'after'->>'attribution_status';
 IF n <> 0 THEN
  RAISE EXCEPTION 'bucket_rerun_l1g undo: % rows were re-decided after the re-run; refusing to overwrite them', n;
 END IF;
 -- A binding the re-run made that is no longer exactly that (re-bound, retired, moved) is not this undo's to delete.
 SELECT count(*) INTO n FROM rr_undo_bound b
 WHERE NOT EXISTS (SELECT 1 FROM public.event_threads t WHERE t.thread_key = b.thread_key AND t.source_event_id = b.id
                   AND t.job_id = b.job_id AND t.retired_at IS NULL);
 IF n <> 0 THEN RAISE EXCEPTION 'bucket_rerun_l1g undo: % bindings the re-run made have changed since; refusing', n; END IF;
 SELECT count(*) INTO n FROM rr_undo_retired r
 WHERE NOT EXISTS (SELECT 1 FROM public.event_threads t WHERE t.thread_key = r.thread_key AND t.retired_at = r.retired_at);
 IF n <> 0 THEN RAISE EXCEPTION 'bucket_rerun_l1g undo: % bindings the re-run retired have changed since; refusing', n; END IF;

 has_trigger := EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.business_events'::regclass
  AND t.tgname = 'context_party_roles_business_event' AND NOT t.tgisinternal);
 IF has_trigger THEN EXECUTE 'ALTER TABLE public.business_events DISABLE TRIGGER context_party_roles_business_event'; END IF;
 UPDATE public.business_events e SET
  job_id = (u.rr->'prior'->>'job_id')::uuid,
  contact_id = u.rr->'prior'->>'contact_id',
  attribution_status = u.rr->'prior'->>'attribution_status',
  attribution_step = (u.rr->'prior'->>'attribution_step')::smallint,
  attribution_confidence = (u.rr->'prior'->>'attribution_confidence')::numeric,
  attributed_at = (u.rr->'prior'->>'attributed_at')::timestamptz,
  attribution_checked_at = (u.rr->'prior'->>'attribution_checked_at')::timestamptz,
  event_at = (u.rr->'prior'->>'event_at')::timestamptz,
  match_status = u.rr->'prior'->>'match_status',
  match_method = u.rr->'prior'->>'match_method',
  match_confidence = (u.rr->'prior'->>'match_confidence')::numeric,
  candidate_job_ids = CASE WHEN jsonb_typeof(u.rr->'prior'->'candidate_job_ids') = 'array'
   THEN ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(u.rr->'prior'->'candidate_job_ids') x) END,
  payload = (coalesce(e.payload, '{}'::jsonb) - 'terminal_time_source' - 'attribution_error') || coalesce(u.rr->'prior'->'payload_keys', '{}'::jsonb),
  metadata = u.rr->'prior'->'metadata'
 FROM rr_undo u WHERE e.id = u.id;
 GET DIAGNOSTICS restored = ROW_COUNT;
 IF has_trigger THEN EXECUTE 'ALTER TABLE public.business_events ENABLE TRIGGER context_party_roles_business_event'; END IF;
 IF restored <> expected_rows THEN
  RAISE EXCEPTION 'bucket_rerun_l1g undo: restored % rows, expected %; refusing', restored, expected_rows;
 END IF;
 DELETE FROM public.event_threads t USING rr_undo_bound b
 WHERE t.thread_key = b.thread_key AND t.source_event_id = b.id AND t.job_id = b.job_id AND t.retired_at IS NULL;
 UPDATE public.event_threads t SET retired_at = NULL, retired_reason = NULL, retired_conflict_job_id = NULL
 FROM rr_undo_retired r WHERE t.thread_key = r.thread_key AND t.retired_at = r.retired_at;
 -- Every row reads as before the re-run.
 SELECT count(*) INTO n FROM public.business_events e JOIN rr_undo u ON u.id = e.id
 WHERE e.metadata IS DISTINCT FROM u.rr->'prior'->'metadata'
  OR e.job_id IS DISTINCT FROM (u.rr->'prior'->>'job_id')::uuid
  OR e.attribution_status IS DISTINCT FROM u.rr->'prior'->>'attribution_status'
  OR e.candidate_job_ids IS DISTINCT FROM (CASE WHEN jsonb_typeof(u.rr->'prior'->'candidate_job_ids') = 'array'
     THEN ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(u.rr->'prior'->'candidate_job_ids') x) END);
 IF n <> 0 THEN RAISE EXCEPTION 'bucket_rerun_l1g undo: % rows do not read as before the re-run; refusing', n; END IF;
 IF has_trigger AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.business_events'::regclass
   AND t.tgname = 'context_party_roles_business_event' AND t.tgenabled <> 'D') THEN
  RAISE EXCEPTION 'bucket_rerun_l1g undo: the party-role trigger is not enabled again; refusing';
 END IF;
END $undo$;
SELECT (SELECT count(*) FROM rr_undo) AS rows_restored, (SELECT count(*) FROM rr_undo_bound) AS bindings_removed,
 (SELECT count(*) FROM rr_undo_retired) AS retirements_cleared;
ROLLBACK;
