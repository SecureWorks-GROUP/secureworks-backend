-- scripts/context-grades-load-undo.sql
-- Remove one loaded sample from public.context_grades: the undo of scripts/context-grades-load.sql. Draft, 7 Oct 2026.
-- NEEDS MARNIN'S GO to commit: the scorecard then reads the previous sample of each kind (or none) for rows 7 to 9.
--
-- HOW TO RUN (Supabase SQL editor or psql, as postgres: the service role may insert grades but never delete them)
--   1. Set grades.sample_id to the sample to remove, and grades.expect to its rows per kind exactly as the load's
--      grades.expect gave them (a kind not loaded under this sample id is 0 and is left alone).
--   2. As written: a dry run. It removes, checks and ends in ROLLBACK. Nothing changes. Read the last result.
--   3. The real undo, only on Marnin's go: the same text with COMMIT in place of the last ROLLBACK.
--
-- GUARDS: the sample id is a sample id; for every kind the rows stored under it equal grades.expect exactly (so a
--   sample loaded twice under one id, or a wrong count, refuses); at least one row is removed.
-- WHAT IT CHANGES: deletes exactly those rows. Every other sample, kind and table is untouched.
-- CHECKS AFTER: no row of the sample is left for the kinds removed; every other row is still there; the last result
--   is what context_grades_newest reads now.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. The sample to remove.
SELECT set_config('grades.sample_id', 'PASTE-SAMPLE-ID', true);
SELECT set_config('grades.expect', '{"ledger": 0, "story": 0, "agent": 0}', true);  -- the load's own counts per kind

-- 1. Before.
DO $before$
DECLARE problems text[] := '{}'; x record; v_expect jsonb; v_sample text := current_setting('grades.sample_id'); n integer;
BEGIN
 IF v_sample = 'PASTE-SAMPLE-ID' OR v_sample !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$' THEN
  RAISE EXCEPTION 'grades_undo_guard: set grades.sample_id to the sample to remove';
 END IF;
 BEGIN v_expect := current_setting('grades.expect')::jsonb;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'grades_undo_guard: grades.expect is not JSON';
 END;
 IF jsonb_typeof(v_expect) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'grades_undo_guard: grades.expect must be {"ledger": n, "story": n, "agent": n}';
 END IF;
 IF NOT (v_expect ?& ARRAY['ledger', 'story', 'agent'])
  OR EXISTS (SELECT 1 FROM jsonb_each(v_expect) e WHERE e.key NOT IN ('ledger', 'story', 'agent')
             OR jsonb_typeof(e.value) IS DISTINCT FROM 'number' OR e.value::text !~ '^[0-9]{1,5}$') THEN
  RAISE EXCEPTION 'grades_undo_guard: grades.expect must be {"ledger": n, "story": n, "agent": n}, whole numbers';
 END IF;
 IF to_regclass('public.context_grades') IS NULL
  OR coalesce(obj_description(to_regclass('public.context_grades'), 'pg_class'), '') NOT LIKE 'Context grades (20261007090000)%' THEN
  RAISE EXCEPTION 'grades_undo_guard: public.context_grades is missing or not migration 20261007090000''s';
 END IF;
 FOR x IN SELECT k.kind, (v_expect ->> k.kind)::integer AS want,
                 (SELECT count(*) FROM public.context_grades c WHERE c.kind = k.kind AND c.sample_id = v_sample)::integer AS got
          FROM (VALUES ('ledger'), ('story'), ('agent')) AS k(kind) LOOP
  IF x.got <> x.want THEN
   problems := problems || format('sample %s holds %s rows of kind %s, grades.expect says %s', v_sample, x.got, x.kind, x.want);
  END IF;
 END LOOP;
 n := (v_expect ->> 'ledger')::integer + (v_expect ->> 'story')::integer + (v_expect ->> 'agent')::integer;
 IF n = 0 THEN problems := problems || 'grades.expect removes nothing'::text; END IF;
 IF cardinality(problems) > 0 THEN RAISE EXCEPTION 'grades_undo_guard: %', array_to_string(problems, '; '); END IF;
 PERFORM set_config('grades.before', (SELECT count(*) FROM public.context_grades)::text, true);
 PERFORM set_config('grades.remove', n::text, true);
END $before$;

-- 2. The undo: exactly the sample's rows of the kinds named.
DO $write$
DECLARE n integer; v_expect jsonb := current_setting('grades.expect')::jsonb; v_sample text := current_setting('grades.sample_id');
BEGIN
 DELETE FROM public.context_grades c
 WHERE c.sample_id = v_sample
   AND c.kind IN (SELECT k.kind FROM (VALUES ('ledger'), ('story'), ('agent')) AS k(kind) WHERE (v_expect ->> k.kind)::integer > 0);
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> current_setting('grades.remove')::integer THEN
  RAISE EXCEPTION 'grades_undo_guard: % rows removed, % expected', n, current_setting('grades.remove');
 END IF;
END $write$;

-- 3. After: none of the sample is left for those kinds, and every other row is still there.
DO $after$
DECLARE v_expect jsonb := current_setting('grades.expect')::jsonb; v_sample text := current_setting('grades.sample_id');
BEGIN
 IF EXISTS (SELECT 1 FROM public.context_grades c WHERE c.sample_id = v_sample
            AND c.kind IN (SELECT k.kind FROM (VALUES ('ledger'), ('story'), ('agent')) AS k(kind) WHERE (v_expect ->> k.kind)::integer > 0)) THEN
  RAISE EXCEPTION 'grades_undo_guard: a row of the sample is left';
 END IF;
 IF (SELECT count(*) FROM public.context_grades) <> current_setting('grades.before')::integer - current_setting('grades.remove')::integer THEN
  RAISE EXCEPTION 'grades_undo_guard: the table holds % rows, expected % less %', (SELECT count(*) FROM public.context_grades),
   current_setting('grades.before'), current_setting('grades.remove');
 END IF;
END $after$;

-- 4. What the scorecard reads now.
SELECT g.kind, g.samples, g.sample_id, g.graded_at, g.units, g.passed, g.pass_pct, g.jobs, g.unsafe_lines
FROM public.context_grades_newest(now()) g;

ROLLBACK;  -- the dry run. The real undo, on Marnin's go only: COMMIT in place of this ROLLBACK.
