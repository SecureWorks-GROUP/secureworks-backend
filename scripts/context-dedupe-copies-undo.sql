-- Undo for scripts/context-dedupe-copies.sql (gap map W9, 6 Oct 2026).
--
-- Removes exactly the marks that script wrote: metadata.duplicate_of and
-- metadata.duplicate_marked on rows whose duplicate_marked.by is
-- context_dedupe_copies_20261006. A mark written by anything else is left
-- alone. No other column or metadata key changes, except that the party roles
-- trigger re-stamps party_roles to the current classifier on every metadata
-- update (version only; checked below). The rows then read exactly as before
-- the marking: admissible, unread where they had no receipt, in the catch-up
-- set.
--
-- How to run (production: a write only with the owner's go). As written it
-- ends in ROLLBACK: a dry run. First read the count:
--   BEGIN READ ONLY;
--   SELECT count(*) FROM public.business_events
--    WHERE metadata -> 'duplicate_marked' ->> 'by' = 'context_dedupe_copies_20261006';
--   ROLLBACK;
-- put it in expected_rows below, run this file, then (owner's go) change the
-- final ROLLBACK to COMMIT and run it once.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE dedupe_undo_before ON COMMIT DROP AS
SELECT e.id, e.job_id, e.attribution_status, e.payload, e.provider_message_id, e.metadata
FROM public.business_events e
WHERE e.metadata -> 'duplicate_marked' ->> 'by' = 'context_dedupe_copies_20261006';

DO $undo$
DECLARE
 -- The number of rows the marking committed (256 in the 6 Oct 2026 plan).
 expected_rows constant integer := 256;
 n integer; cleared integer;
BEGIN
 SELECT count(*) INTO n FROM dedupe_undo_before;
 IF n <> expected_rows THEN
  RAISE EXCEPTION 'dedupe_undo_guard_count: % rows carry this script''s mark, expected %', n, expected_rows;
 END IF;
 IF EXISTS (SELECT 1 FROM dedupe_undo_before WHERE metadata ->> 'duplicate_of' IS NULL) THEN
  RAISE EXCEPTION 'dedupe_undo_guard_shape: a marked row has no duplicate_of';
 END IF;

 UPDATE public.business_events e
 SET metadata = e.metadata - 'duplicate_of' - 'duplicate_marked'
 WHERE e.id IN (SELECT id FROM dedupe_undo_before);
 GET DIAGNOSTICS cleared = ROW_COUNT;
 IF cleared <> expected_rows THEN
  RAISE EXCEPTION 'dedupe_undo_guard_written: % rows cleared, expected %', cleared, expected_rows;
 END IF;

 IF EXISTS (SELECT 1 FROM dedupe_undo_before b JOIN public.business_events e ON e.id = b.id
   WHERE e.job_id IS DISTINCT FROM b.job_id OR e.attribution_status IS DISTINCT FROM b.attribution_status
    OR e.payload IS DISTINCT FROM b.payload OR e.provider_message_id IS DISTINCT FROM b.provider_message_id
    OR e.metadata ? 'duplicate_of' OR e.metadata ? 'duplicate_marked'
    OR (e.metadata - 'party_roles') IS DISTINCT FROM (b.metadata - 'duplicate_of' - 'duplicate_marked' - 'party_roles')
    OR ((e.metadata -> 'party_roles') - 'version') IS DISTINCT FROM ((b.metadata -> 'party_roles') - 'version')) THEN
  RAISE EXCEPTION 'dedupe_undo_guard_side_effect: the undo changed more than the mark';
 END IF;
 RAISE NOTICE 'dedupe undo: cleared % marks', cleared;
END $undo$;

SELECT jsonb_build_object(
 'still_marked_by_this_script', (SELECT count(*) FROM public.business_events e
   WHERE e.metadata -> 'duplicate_marked' ->> 'by' = 'context_dedupe_copies_20261006'),
 'cleared_rows_admissible_again', (SELECT count(*) FROM public.business_events e
   WHERE e.id IN (SELECT id FROM dedupe_undo_before) AND public.context_event_source_admissible(e))
) AS after_undo;

ROLLBACK;
