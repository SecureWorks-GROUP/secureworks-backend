-- Undo for scripts/context-placement-grades-load.sql (7 Oct 2026): removes one
-- loaded placement sample, whole, from context_placement_grades. Nothing else
-- is touched (the grades are a measurement; no business row depends on them).
-- The service role may not delete grades, so this runs as the database owner.
--
-- How to run (a write: only with the owner's go). As written it ends in
-- ROLLBACK: a dry run. Set the sample and its row count:
--   BEGIN READ ONLY;
--   SELECT sample_id, count(*) FROM public.context_placement_grades GROUP BY 1 ORDER BY 1;
--   ROLLBACK;
-- then run this file, then (owner's go) change the final ROLLBACK to COMMIT and
-- run it once. Unload every sample before the migration's rollback, which
-- refuses while any grade is stored.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $undo$
DECLARE
 expected_sample_id constant text := 'placement-cf-YYYYMMDDtHHMMSSz-n120-d30';
 expected_rows constant integer := 120;
 n integer;
BEGIN
 SELECT count(*) INTO n FROM public.context_placement_grades g WHERE g.sample_id = expected_sample_id;
 IF n <> expected_rows THEN
  RAISE EXCEPTION 'placement_grades_load undo: sample % has % rows, expected %; refusing', expected_sample_id, n, expected_rows;
 END IF;
 DELETE FROM public.context_placement_grades g WHERE g.sample_id = expected_sample_id;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> expected_rows THEN RAISE EXCEPTION 'placement_grades_load undo: removed % rows, expected %; refusing', n, expected_rows; END IF;
END $undo$;
SELECT * FROM public.context_placement_grades_newest(now(), 'customer_facing')
UNION ALL SELECT * FROM public.context_placement_grades_newest(now(), 'xero_and_quotes');
ROLLBACK;
