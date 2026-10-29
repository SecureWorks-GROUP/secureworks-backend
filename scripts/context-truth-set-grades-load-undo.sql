-- Undo for scripts/context-truth-set-grades-load.sql (29 Oct 2026): removes one loaded TP-19 truth set, whole,
-- from public.context_truth_set_grades. Nothing else is touched (the grades are a measurement; no business row
-- depends on them). The service role may not delete grades, so this runs as the database owner.
--
-- How to run (a write: only with the owner's go). As written it ends in ROLLBACK: a dry run. Set the set and its
-- row count (BEGIN READ ONLY; SELECT set_id, count(*) FROM public.context_truth_set_grades GROUP BY 1 ORDER BY 1;
-- ROLLBACK; lists them), run this file, then (owner's go) change the final ROLLBACK to COMMIT and run it once.
-- Unload every set before the migration's rollback, which refuses while any grade is stored.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT set_config('truth.set_id', 'PASTE-SET-ID', true);  -- the set to remove
SELECT set_config('truth.rows', '0', true);               -- how many rows it holds (its drawn)

DO $undo$
DECLARE
 v_set text := current_setting('truth.set_id'); v_rows integer := current_setting('truth.rows')::integer; n integer;
BEGIN
 IF to_regclass('public.context_truth_set_grades') IS NULL THEN
  RAISE EXCEPTION 'truth_set_load undo: migration 20261029150000 is not live; refusing';
 END IF;
 SELECT count(*) INTO n FROM public.context_truth_set_grades g WHERE g.set_id = v_set;
 IF n <> v_rows OR v_rows < 1 THEN
  RAISE EXCEPTION 'truth_set_load undo: set % has % rows, expected %; refusing', v_set, n, v_rows;
 END IF;
 DELETE FROM public.context_truth_set_grades g WHERE g.set_id = v_set;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> v_rows THEN RAISE EXCEPTION 'truth_set_load undo: removed % rows, expected %; refusing', n, v_rows; END IF;
END $undo$;
SELECT count(*) AS rows_left_for_set FROM public.context_truth_set_grades g WHERE g.set_id = current_setting('truth.set_id');
ROLLBACK;  -- the dry run. On the owner's go only: COMMIT in place of this ROLLBACK.
