-- Load one graded placement sample into context_placement_grades (done
-- definition row 3, 7 Oct 2026). Pair with
-- scripts/context-placement-grades-load-undo.sql. Production: only after
-- migration 20261007070000 is applied.
--
-- Not run by its author. As written it ends in ROLLBACK: a dry run that loads,
-- checks and throws the sample away.
--
-- Where the input comes from (docs/context/placement-grading.md): the draw,
-- saved when it was made (SELECT * FROM public.context_placement_sample(...):
-- sample_id, as_of, event_id, placed_job_id, stratum, stratum_rows), joined by
-- event_id to the grader's answer file (event_id, verdict, reason,
-- right_job_id), with the grader's name and when the grade was given. One JSON
-- object per graded message, ids and codes only:
--   {"sample_id": "...", "as_of": "...", "event_id": "...", "placed_job_id": "...",
--    "stratum": "...", "stratum_rows": 0, "verdict": "right|wrong|unsure",
--    "reason": null|"other_job"|"no_job"|"several_jobs"|"not_enough_evidence",
--    "right_job_id": null|"...", "grader": "...", "graded_at": "..."}
-- Never words: an object with any other key refuses.
--
-- How to run (a write: only with the owner's go, or the authority the rulings
-- register names for loading grades). Paste the array in place of the '[]'
-- below, set expected_sample_id and expected_rows, run this file, read the
-- newest-sample line it prints, then change the final ROLLBACK to COMMIT and
-- run it once. The table takes each sample once: a second load of the same
-- sample refuses; to correct one, unload it with the undo and load it again.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE pg_input ON COMMIT DROP AS
SELECT '[]'::jsonb AS grades;

CREATE TEMP TABLE pg_load ON COMMIT DROP AS
SELECT r.* FROM pg_input i, jsonb_to_recordset(i.grades) AS r(sample_id text, as_of timestamptz, event_id uuid, placed_job_id uuid,
 stratum text, stratum_rows integer, verdict text, reason text, right_job_id uuid, grader text, graded_at timestamptz);

DO $check$
DECLARE
 -- The sample (its context_placement_sample id) and how many graded messages it carries.
 expected_sample_id constant text := 'placement-YYYYMMDDtHHMMSSz-n120-d30';
 expected_rows constant integer := 120;
 n integer;
BEGIN
 IF to_regclass('public.context_placement_grades') IS NULL THEN
  RAISE EXCEPTION 'placement_grades_load: migration 20261007070000 is not live; refusing';
 END IF;
 IF jsonb_typeof((SELECT grades FROM pg_input)) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'placement_grades_load: the input is not one JSON array; refusing';
 END IF;
 SELECT count(*) INTO n FROM pg_input i, jsonb_array_elements(i.grades) g, jsonb_object_keys(g) k
 WHERE k NOT IN ('sample_id', 'as_of', 'event_id', 'placed_job_id', 'stratum', 'stratum_rows', 'verdict', 'reason', 'right_job_id',
                 'grader', 'graded_at');
 IF n <> 0 THEN RAISE EXCEPTION 'placement_grades_load: % input keys are not ids or codes; refusing (never words)', n; END IF;
 SELECT count(*) INTO n FROM pg_load;
 IF n <> expected_rows THEN RAISE EXCEPTION 'placement_grades_load: % graded messages, expected %; refusing', n, expected_rows; END IF;
 IF (SELECT count(DISTINCT l.event_id) FROM pg_load l) <> n OR EXISTS (SELECT 1 FROM pg_load l WHERE l.event_id IS NULL) THEN
  RAISE EXCEPTION 'placement_grades_load: a message is missing or graded twice; refusing';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_load l WHERE l.sample_id IS DISTINCT FROM expected_sample_id)
  OR (SELECT count(DISTINCT l.as_of) FROM pg_load l) <> 1 THEN
  RAISE EXCEPTION 'placement_grades_load: every row must carry sample % and one draw instant; refusing', expected_sample_id;
 END IF;
 IF EXISTS (SELECT 1 FROM public.context_placement_grades g WHERE g.sample_id = expected_sample_id) THEN
  RAISE EXCEPTION 'placement_grades_load: sample % is already loaded; unload it first to replace it', expected_sample_id;
 END IF;
 SELECT count(*) INTO n FROM pg_load l WHERE NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.id = l.event_id);
 IF n <> 0 THEN RAISE EXCEPTION 'placement_grades_load: % graded messages do not exist; refusing', n; END IF;
 -- The draw's own facts: each stratum one size, and each drawn job the job the message sat on then (it may have
 -- moved since: reported below, not refused).
 IF EXISTS (SELECT 1 FROM pg_load l GROUP BY l.stratum HAVING count(DISTINCT l.stratum_rows) <> 1) THEN
  RAISE EXCEPTION 'placement_grades_load: a stratum carries two sizes; copy stratum_rows from the draw; refusing';
 END IF;
END $check$;

INSERT INTO public.context_placement_grades (sample_id, as_of, event_id, placed_job_id, stratum, stratum_rows, verdict, reason,
 right_job_id, grader, graded_at)
SELECT l.sample_id, l.as_of, l.event_id, l.placed_job_id, l.stratum, l.stratum_rows, l.verdict, l.reason, l.right_job_id, l.grader, l.graded_at
FROM pg_load l;

-- What was loaded, and how the newest sample reads now.
SELECT l.stratum, l.verdict, coalesce(l.reason, '-') AS reason, count(*) AS rows,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.business_events b WHERE b.id = l.event_id AND b.job_id IS DISTINCT FROM l.placed_job_id))
  AS moved_since_draw
FROM pg_load l GROUP BY l.stratum, l.verdict, coalesce(l.reason, '-')
ORDER BY l.stratum COLLATE "C", l.verdict COLLATE "C", coalesce(l.reason, '-') COLLATE "C";
SELECT * FROM public.context_placement_grades_newest(now());
ROLLBACK;
