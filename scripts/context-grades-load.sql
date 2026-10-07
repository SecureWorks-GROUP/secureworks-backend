-- scripts/context-grades-load.sql
-- Load one finished grade into public.context_grades (migration 20261007090000), the data source of done-definition
-- rows 7, 8 and 9. Pair with scripts/context-grades-load-undo.sql. Draft, 7 Oct 2026. NEEDS MARNIN'S GO to commit:
-- the scorecard reads the newest sample of each kind, so a commit changes what rows 7 to 9 say.
--
-- WHAT A GRADE IS. One sample: every graded unit of one grading run, each with its verdicts per test
-- (grade-kit/RUBRIC.md, ops/golive/GRADE-PLAN.md, grade-kit/t7):
--   kind ledger  one ledger item, row 7 (T5 verbatim, parties, supported; T8)    unit = the ledger item's id
--   kind story   one job's story card, row 8 (T1 to T4, T6, T8 and the rest)     unit = story
--   kind agent   one T7 agent call, row 9 and 9+                                 unit = where_at, last_told, owed,
--                                                                                       story or period
-- Codes, counts and row ids only: the table's own check refuses any other key or value, so no word can be loaded.
--
-- HOW TO RUN (Supabase SQL editor or psql, as postgres)
--   1. Paste the grade into section 0, between the two $grade$ markers, and fill the settings under it. The paste is
--      one of:
--      (a) a context-grades-v1 document: the grade folder's grades.json, which the grade's orchestrator writes from
--          the graders' results (shape under WHAT TO PASTE);
--      (b) a finished T7 run's grade.json exactly as grade-kit/t7/score_t7.py wrote it, once the independent grader
--          has filled grader on every graded row (correct or wrong), grader on every story loop (covered or missed)
--          and added unsafe_lines (a whole number, 0 when none) to every row. score_t7 writes ids, codes and counts
--          only, so the file holds no customer words. A call that was never run (reply "missing") is left out when
--          it is optional and refused when it is gated.
--      The file as shipped holds a placeholder, so it refuses until a grade is pasted.
--   2. As written: a dry run. It loads, checks, proves the undo, prints the sample as the scorecard will read it,
--      and ends in ROLLBACK. Nothing changes. Read the last result.
--   3. The real load, only on Marnin's go: the same text with COMMIT in place of the last ROLLBACK.
--   The undo: scripts/context-grades-load-undo.sql with the same sample id and counts (same go needed).
--
-- WHAT TO PASTE, shape (a):
--   {"version": "context-grades-v1", "sample_id": "<the sample id below>", "as_of": "<T_g, the instant every
--    graded output and record was read as of, UTC>",
--    "units": [{"kind": "ledger", "job_number": "SWF-...", "job_id": "<uuid>", "unit": "<ledger item id>",
--               "generation_id": "<the reading graded>", "reading_model": "<its model>", "item_type": "<its type>",
--               "stratum": null, "gated": true, "grader": "grader-1", "graded_at": "<UTC>",
--               "verdicts": {"verbatim": "pass", "parties": "pass", "supported": "pass", "unsafe": 0}},
--              {"kind": "story", "job_number": "SWF-...", "job_id": "<uuid>", "unit": "story",
--               "generation_id": "<the reading the story showed, or null for records only>", "reading_model": ...,
--               "gated": true, "grader": "grader-2", "graded_at": "<UTC>", "verdicts": {...}}]}
--   job_number is the job's number, or "(no number)" for a job that has none; it must match job_id.
--
-- HOW TO WRITE THE VERDICTS (public.context_grade_verdicts_problem is the rule; pass or fail unless named):
--   ledger  verbatim, parties, supported (T5), unsafe (T8: 1 when this item is an unsafe line, else 0). Required.
--   story   first_line (T6) and unsafe (T8: unsafe lines in the story and the preview's now and handling, a count)
--           are required; the rest when graded: timeline (T1), record_loops (T2), recall (T3:
--           {"money": {"found", "total"}, "record": {...}, "message": {...}}), precision (T4: {"real", "shown"}),
--           first_line_set (known or unseen), money (every amount to the cent), dates (every weekday right),
--           honesty (not_known names the real gaps; nothing more certain than the rows), orientation (1 to 5).
--   agent   where_at, last_told, owed and period: answer (correct or wrong) and unsafe (a count); story: loops
--           ({"covered", "applicable"}) and unsafe. Any of them may carry action_cards (a count; any card fails the
--           call) and story_tool (true or false). The key's loop ids are never loaded (some carry a first name):
--           only how many applicable loops the reply covered.
--   Any unit may carry unsafe_classes ([1 to 4], with unsafe above 0) and rows ([{"t": table, "id": id}], up to 25
--   proving rows). A unit passes by public.context_grade_passed: the scorecard's pass share counts those.
--
-- GUARDS (every one must hold, or nothing is written)
--   The paste: JSON in one of the two shapes; no placeholder. Shape (a): its sample_id equals grades.sample_id.
--   Shape (b): grades.t7_as_of (the run's start, run.json), grades.t7_grader and grades.t7_graded_at are set.
--   Exact counts: the units of each kind and the gated units equal grades.expect, which you set from the grade's own
--   totals (for T7: 40 gated calls plus the optional calls that were run).
--   The sample is new: no unit of this sample id is stored for a kind being loaded (a sample loads once; to replace
--   one, undo it first or name a new sample).
--   Every unit: its job exists and its number matches; one unit once; its verdicts pass the table's check (each
--   failure named by unit number); its grader is a grader name or person:<user id>; graded at or after as_of and not
--   after now. A ledger unit names a ledger item of that reading, that job and that type, and a reading of that job
--   by that model. A story or agent unit that names a reading names one of its job by that model.
--   The migration 20261007090000 is applied and the table is its own.
--
-- WHAT IT CHANGES: inserts exactly the pasted units into public.context_grades under grades.sample_id. Nothing else:
--   no ledger item, reading, story, flag or business row is touched.
--
-- CHECKS AFTER (in the same transaction): exactly grades.expect rows of this sample per kind, the table grown by
--   exactly the load, context_grade_samples reading the sample with every unit, and the undo removing exactly these
--   rows and nothing else (proven in a subtransaction that is always rolled back). The last result is the sample as
--   context_grades_newest and the scorecard will read it.
--
-- Never run on production without the owner's go. Proven only on a disposable local database (PR body).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. The grade and its settings. Paste between the markers, then fill the settings.
CREATE TEMP TABLE grades_paste ON COMMIT DROP AS SELECT $grade$
PASTE THE GRADE HERE
$grade$::text AS doc;
SELECT set_config('grades.sample_id', 'PASTE-SAMPLE-ID', true);  -- 3 to 80 of A-Z a-z 0-9 . _ : -, e.g. golive-a-20261008T020000Z
SELECT set_config('grades.expect', '{"ledger": 0, "story": 0, "agent": 0, "gated": 0}', true);  -- exact units per kind, and gated units
-- Shape (b), a T7 run, only: its grade.json carries no sample fields.
SELECT set_config('grades.t7_as_of', '', true);      -- the run's start (run.json), UTC
SELECT set_config('grades.t7_grader', '', true);     -- the independent grader, e.g. grader-t7
SELECT set_config('grades.t7_graded_at', '', true);  -- when that grader finished, UTC

-- 1. Read the paste into one row per unit, in the table's own shape.
CREATE TEMP TABLE grades_units (
 n integer PRIMARY KEY, kind text, job_number text, job_id uuid, unit text, generation_id uuid, reading_model text,
 item_type text, stratum text, gated boolean, verdicts jsonb, grader text, as_of timestamptz, graded_at timestamptz
) ON COMMIT DROP;
DO $read$
DECLARE
 v_raw text := (SELECT p.doc FROM grades_paste p);
 v_doc jsonb; v_expect jsonb; v_as_of timestamptz; v_graded timestamptz; v_grader text;
 v_sample text := current_setting('grades.sample_id');
 problems text[] := '{}'; u record; v_fmt text; v_skipped integer := 0; v_verdicts jsonb; v_loops jsonb;
 uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 unit_keys constant text[] := ARRAY['kind', 'job_number', 'job_id', 'unit', 'generation_id', 'reading_model', 'item_type',
  'stratum', 'gated', 'grader', 'graded_at', 'verdicts'];
BEGIN
 IF btrim(v_raw) = 'PASTE THE GRADE HERE' OR v_sample = 'PASTE-SAMPLE-ID' THEN
  RAISE EXCEPTION 'grades_load_guard: paste the grade and set grades.sample_id in section 0';
 END IF;
 BEGIN v_doc := v_raw::jsonb;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'grades_load_guard: the paste is not JSON (%)', SQLERRM;
 END;
 BEGIN v_expect := current_setting('grades.expect')::jsonb;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'grades_load_guard: grades.expect is not JSON';
 END;
 IF jsonb_typeof(v_expect) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'grades_load_guard: grades.expect must be {"ledger": n, "story": n, "agent": n, "gated": n}';
 END IF;
 IF NOT (v_expect ?& ARRAY['ledger', 'story', 'agent', 'gated'])
  OR EXISTS (SELECT 1 FROM jsonb_each(v_expect) e WHERE e.key NOT IN ('ledger', 'story', 'agent', 'gated')
             OR jsonb_typeof(e.value) IS DISTINCT FROM 'number' OR e.value::text !~ '^[0-9]{1,5}$') THEN
  RAISE EXCEPTION 'grades_load_guard: grades.expect must be {"ledger": n, "story": n, "agent": n, "gated": n}, whole numbers';
 END IF;
 IF v_sample !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$' THEN
  problems := problems || format('grades.sample_id %s is not a sample id (3 to 80 of A-Z a-z 0-9 . _ : -)', v_sample);
 END IF;

 IF jsonb_typeof(v_doc) = 'object' AND v_doc ->> 'version' IS NOT DISTINCT FROM 'context-grades-v1' THEN
  -- Shape (a).
  v_fmt := 'context-grades-v1';
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_doc) k WHERE k NOT IN ('version', 'sample_id', 'as_of', 'units')) THEN
   problems := problems || 'the document has a key other than version, sample_id, as_of and units'::text;
  END IF;
  IF v_doc ->> 'sample_id' IS DISTINCT FROM v_sample THEN
   problems := problems || format('the document''s sample_id %s is not grades.sample_id %s', coalesce(v_doc ->> 'sample_id', '<none>'), v_sample);
  END IF;
  BEGIN v_as_of := (v_doc ->> 'as_of')::timestamptz;
  EXCEPTION WHEN OTHERS THEN v_as_of := NULL;
  END;
  IF v_as_of IS NULL THEN problems := problems || 'as_of is not a time'::text; END IF;
  IF jsonb_typeof(v_doc -> 'units') IS DISTINCT FROM 'array' THEN
   problems := problems || 'units is not a list'::text;
  ELSE
   FOR u IN SELECT e.value AS v, e.ordinality::integer AS n FROM jsonb_array_elements(v_doc -> 'units') WITH ORDINALITY AS e LOOP
    IF jsonb_typeof(u.v) IS DISTINCT FROM 'object' THEN problems := problems || format('unit %s is not an object', u.n); CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(u.v) k WHERE NOT k = ANY (unit_keys)) THEN
     problems := problems || format('unit %s has a key that is not a column', u.n); CONTINUE;
    END IF;
    IF NOT (u.v ?& ARRAY['kind', 'job_number', 'job_id', 'unit', 'grader', 'graded_at', 'verdicts']) THEN
     problems := problems || format('unit %s misses kind, job_number, job_id, unit, grader, graded_at or verdicts', u.n); CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(u.v) e WHERE e.key NOT IN ('gated', 'verdicts') AND jsonb_typeof(e.value) NOT IN ('string', 'null'))
     OR jsonb_typeof(u.v -> 'gated') NOT IN ('boolean', 'null') THEN
     problems := problems || format('unit %s: every field is text or null, gated true or false', u.n); CONTINUE;
    END IF;
    IF coalesce(u.v ->> 'job_id', '') !~ uuid_re OR coalesce(u.v ->> 'generation_id', '00000000-0000-0000-0000-000000000000') !~ uuid_re THEN
     problems := problems || format('unit %s: job_id or generation_id is not an id', u.n); CONTINUE;
    END IF;
    BEGIN v_graded := (u.v ->> 'graded_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN v_graded := NULL;
    END;
    IF v_graded IS NULL THEN problems := problems || format('unit %s: graded_at is not a time', u.n); CONTINUE; END IF;
    INSERT INTO grades_units (n, kind, job_number, job_id, unit, generation_id, reading_model, item_type, stratum, gated, verdicts,
     grader, as_of, graded_at)
    VALUES (u.n, u.v ->> 'kind', u.v ->> 'job_number', (u.v ->> 'job_id')::uuid, u.v ->> 'unit', (u.v ->> 'generation_id')::uuid,
     u.v ->> 'reading_model', u.v ->> 'item_type', u.v ->> 'stratum', coalesce((u.v ->> 'gated')::boolean, true), u.v -> 'verdicts',
     u.v ->> 'grader', v_as_of, v_graded);
   END LOOP;
  END IF;

 ELSIF jsonb_typeof(v_doc) = 'array' THEN
  -- Shape (b): a T7 run's grade.json (grade-kit/t7/score_t7.py), graded.
  v_fmt := 't7';
  BEGIN v_as_of := nullif(current_setting('grades.t7_as_of'), '')::timestamptz;
  EXCEPTION WHEN OTHERS THEN v_as_of := NULL;
  END;
  BEGIN v_graded := nullif(current_setting('grades.t7_graded_at'), '')::timestamptz;
  EXCEPTION WHEN OTHERS THEN v_graded := NULL;
  END;
  v_grader := nullif(current_setting('grades.t7_grader'), '');
  IF v_as_of IS NULL OR v_graded IS NULL OR v_grader IS NULL THEN
   problems := problems || 'a T7 run needs grades.t7_as_of, grades.t7_grader and grades.t7_graded_at'::text;
  END IF;
  FOR u IN SELECT e.value AS v, e.ordinality::integer AS n FROM jsonb_array_elements(v_doc) WITH ORDINALITY AS e LOOP
   IF jsonb_typeof(u.v) IS DISTINCT FROM 'object' OR NOT (u.v ?& ARRAY['id', 'job_number', 'kind', 'qid', 'gated', 'reply']) THEN
    problems := problems || format('row %s is not a score_t7 row', u.n); CONTINUE;
   END IF;
   IF jsonb_typeof(u.v -> 'gated') IS DISTINCT FROM 'boolean' THEN problems := problems || format('row %s: gated is not true or false', u.n); CONTINUE; END IF;
   IF u.v ->> 'reply' = 'missing' THEN
    IF (u.v ->> 'gated')::boolean THEN problems := problems || format('row %s (%s): a gated call was not run', u.n, u.v ->> 'id');
    ELSE v_skipped := v_skipped + 1;
    END IF;
    CONTINUE;
   END IF;
   IF NOT coalesce(u.v ->> 'kind' = 'baseline' AND u.v ->> 'qid' IN ('where_at', 'last_told', 'owed')
           OR u.v ->> 'kind' = 'story' AND u.v ->> 'qid' = 'story' OR u.v ->> 'kind' = 'period' AND u.v ->> 'qid' = 'period', false) THEN
    problems := problems || format('row %s (%s): kind %s with question %s', u.n, u.v ->> 'id', u.v ->> 'kind', u.v ->> 'qid'); CONTINUE;
   END IF;
   IF jsonb_typeof(u.v -> 'unsafe_lines') IS DISTINCT FROM 'number' OR (u.v -> 'unsafe_lines')::text !~ '^[0-9]{1,6}$' THEN
    problems := problems || format('row %s (%s): unsafe_lines is not filled with a whole number', u.n, u.v ->> 'id'); CONTINUE;
   END IF;
   v_verdicts := jsonb_build_object('unsafe', u.v -> 'unsafe_lines');
   IF jsonb_typeof(u.v -> 'action_cards') = 'number' THEN v_verdicts := v_verdicts || jsonb_build_object('action_cards', u.v -> 'action_cards'); END IF;
   IF jsonb_typeof(u.v -> 'read_story_tool') = 'boolean' THEN v_verdicts := v_verdicts || jsonb_build_object('story_tool', u.v -> 'read_story_tool'); END IF;
   IF u.v ->> 'kind' = 'story' THEN
    v_loops := coalesce(u.v -> 'loops', '[]'::jsonb);
    IF jsonb_typeof(v_loops) IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_loops) l
                WHERE jsonb_typeof(l) IS DISTINCT FROM 'object' OR jsonb_typeof(l -> 'lid') IS DISTINCT FROM 'string'
                   OR l ->> 'grader' IS NULL OR l ->> 'grader' NOT IN ('covered', 'missed')) THEN
     problems := problems || format('row %s (%s): every story loop needs grader covered or missed', u.n, u.v ->> 'id'); CONTINUE;
    END IF;
    v_verdicts := v_verdicts || jsonb_build_object('loops', jsonb_build_object(
     'covered', (SELECT count(*) FROM jsonb_array_elements(v_loops) l WHERE l ->> 'grader' = 'covered'),
     'applicable', jsonb_array_length(v_loops)));
   ELSE
    IF u.v ->> 'grader' IS NULL OR u.v ->> 'grader' NOT IN ('correct', 'wrong') THEN
     problems := problems || format('row %s (%s): grader is not filled with correct or wrong', u.n, u.v ->> 'id'); CONTINUE;
    END IF;
    IF u.v ->> 'grader' = 'correct' AND u.v ->> 'reply' IS DISTINCT FROM 'present' THEN
     problems := problems || format('row %s (%s): an unreadable or empty reply is graded correct', u.n, u.v ->> 'id'); CONTINUE;
    END IF;
    v_verdicts := v_verdicts || jsonb_build_object('answer', u.v ->> 'grader');
   END IF;
   INSERT INTO grades_units (n, kind, job_number, job_id, unit, generation_id, reading_model, item_type, stratum, gated, verdicts,
    grader, as_of, graded_at)
   VALUES (u.n, 'agent', u.v ->> 'job_number', NULL, u.v ->> 'qid', NULL, NULL, NULL, NULL, (u.v ->> 'gated')::boolean, v_verdicts,
    v_grader, v_as_of, v_graded);
  END LOOP;
  -- The job of each call, by its number (T7's grade.json names no job id): exactly one job per number.
  UPDATE grades_units g SET job_id = (SELECT j.id FROM public.jobs j WHERE j.job_number = g.job_number)
  WHERE (SELECT count(*) FROM public.jobs j WHERE j.job_number = g.job_number) = 1;
  FOR u IN SELECT g.n, g.job_number FROM grades_units g WHERE g.job_id IS NULL ORDER BY g.n LOOP
   problems := problems || format('row %s: job number %s names no job, or more than one', u.n, u.job_number);
  END LOOP;
 ELSE
  RAISE EXCEPTION 'grades_load_guard: the paste is neither a context-grades-v1 document nor a T7 grade.json list';
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'grades_load_guard: %', array_to_string(problems[1:40], '; ')
   || CASE WHEN cardinality(problems) > 40 THEN format(' (and %s more)', cardinality(problems) - 40) ELSE '' END;
 END IF;
 PERFORM set_config('grades.format', v_fmt, true);
 PERFORM set_config('grades.skipped', v_skipped::text, true);
END $read$;

-- 2. Before: every guard, all problems at once.
DO $before$
DECLARE
 problems text[] := '{}'; x record; n integer;
 v_expect jsonb := current_setting('grades.expect')::jsonb; v_sample text := current_setting('grades.sample_id');
 uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
 -- The migration and its table.
 IF to_regclass('public.context_grades') IS NULL
  OR coalesce(obj_description(to_regclass('public.context_grades'), 'pg_class'), '') NOT LIKE 'Context grades (20261007090000)%' THEN
  RAISE EXCEPTION 'grades_load_guard: public.context_grades is missing or not migration 20261007090000''s';
 END IF;
 IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
  problems := problems || 'no migration ledger (supabase_migrations.schema_migrations) to confirm 20261007090000'::text;
 ELSIF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261007090000') THEN
  problems := problems || 'migration 20261007090000 is not applied'::text;
 END IF;
 -- Exact counts.
 IF NOT EXISTS (SELECT 1 FROM grades_units) THEN problems := problems || 'nothing to load'::text; END IF;
 FOR x IN SELECT k.kind, (v_expect ->> k.kind)::integer AS want, (SELECT count(*) FROM grades_units g WHERE g.kind = k.kind)::integer AS got
          FROM (VALUES ('ledger'), ('story'), ('agent')) AS k(kind) LOOP
  IF x.got <> x.want THEN problems := problems || format('%s units: %s pasted, grades.expect says %s', x.kind, x.got, x.want); END IF;
 END LOOP;
 SELECT count(*) INTO n FROM grades_units g WHERE g.gated;
 IF n <> (v_expect ->> 'gated')::integer THEN problems := problems || format('gated units: %s pasted, grades.expect says %s', n, v_expect ->> 'gated'); END IF;
 SELECT count(*) INTO n FROM grades_units g WHERE g.kind IS NULL OR g.kind NOT IN ('ledger', 'story', 'agent');
 IF n > 0 THEN problems := problems || format('%s units have a kind other than ledger, story or agent', n); END IF;
 -- A sample loads once.
 FOR x IN SELECT g.kind FROM grades_units g
          WHERE EXISTS (SELECT 1 FROM public.context_grades c WHERE c.kind = g.kind AND c.sample_id = v_sample)
          GROUP BY g.kind ORDER BY g.kind COLLATE "C" LOOP
  problems := problems || format('sample %s of kind %s is already stored: undo it first or name a new sample', v_sample, x.kind);
 END LOOP;
 -- One unit once.
 FOR x IN SELECT g.kind, g.job_number, g.unit, count(*) AS c FROM grades_units g GROUP BY 1, 2, 3 HAVING count(*) > 1
          ORDER BY g.kind COLLATE "C", g.job_number COLLATE "C", g.unit COLLATE "C" LOOP
  problems := problems || format('%s %s %s is pasted %s times', x.kind, x.job_number, x.unit, x.c);
 END LOOP;
 -- The jobs.
 FOR x IN SELECT g.n, g.job_number FROM grades_units g LEFT JOIN public.jobs j ON j.id = g.job_id
          WHERE j.id IS NULL OR coalesce(j.job_number, '(no number)') IS DISTINCT FROM g.job_number ORDER BY g.n LIMIT 20 LOOP
  problems := problems || format('unit %s: job %s does not exist or has another number', x.n, x.job_number);
 END LOOP;
 -- The unit's own shape: the table's checks, named per unit before the write.
 FOR x IN SELECT g.n, g.kind, g.job_number, g.unit, public.context_grade_verdicts_problem(g.kind, g.unit, g.verdicts) AS p
          FROM grades_units g WHERE public.context_grade_verdicts_problem(g.kind, g.unit, g.verdicts) IS NOT NULL ORDER BY g.n LIMIT 20 LOOP
  problems := problems || format('unit %s (%s %s %s): %s', x.n, x.kind, x.job_number, x.unit, x.p);
 END LOOP;
 FOR x IN SELECT g.n FROM grades_units g
          WHERE NOT CASE g.kind WHEN 'ledger' THEN coalesce(g.unit, '') ~ uuid_re AND g.generation_id IS NOT NULL AND g.item_type IS NOT NULL
                                WHEN 'story' THEN g.unit IS NOT DISTINCT FROM 'story' AND g.item_type IS NULL
                                WHEN 'agent' THEN coalesce(g.unit, '') IN ('where_at', 'last_told', 'owed', 'story', 'period') AND g.item_type IS NULL
                                ELSE false END
             OR (g.generation_id IS NULL) <> (g.reading_model IS NULL)
             OR coalesce(g.grader, '') !~ '^(person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9._-]{0,63})$'
             OR coalesce(g.stratum, 'none') !~ '^[a-z0-9][a-z0-9_:-]{0,39}$'
             OR g.as_of IS NULL OR g.graded_at IS NULL OR g.graded_at < g.as_of OR g.graded_at > now() OR g.as_of > now()
          ORDER BY g.n LIMIT 20 LOOP
  problems := problems || format('unit %s: its unit, reading, item type, grader, stratum or times do not fit its kind', x.n);
 END LOOP;
 -- A ledger unit: an item of that reading, job and type; the reading is that job's, by that model.
 FOR x IN SELECT g.n, g.job_number, g.unit FROM grades_units g
          LEFT JOIN public.context_ledger_items i ON i.id = CASE WHEN g.unit ~ uuid_re THEN g.unit::uuid END
          LEFT JOIN public.context_ledger_generations lg ON lg.id = g.generation_id
          WHERE g.kind = 'ledger'
            AND (i.id IS NULL OR i.generation_id IS DISTINCT FROM g.generation_id OR i.job_id IS DISTINCT FROM g.job_id
                 OR i.item_type IS DISTINCT FROM g.item_type OR lg.id IS NULL OR lg.job_id IS DISTINCT FROM g.job_id
                 OR lg.model IS DISTINCT FROM g.reading_model)
          ORDER BY g.n LIMIT 20 LOOP
  problems := problems || format('unit %s (%s): ledger item %s is not of that reading, job and type, or the reading is not that job''s by that model',
   x.n, x.job_number, x.unit);
 END LOOP;
 -- A story or agent unit that names a reading: that job's, by that model.
 FOR x IN SELECT g.n, g.job_number FROM grades_units g LEFT JOIN public.context_ledger_generations lg ON lg.id = g.generation_id
          WHERE g.kind <> 'ledger' AND g.generation_id IS NOT NULL
            AND (lg.id IS NULL OR lg.job_id IS DISTINCT FROM g.job_id OR lg.model IS DISTINCT FROM g.reading_model)
          ORDER BY g.n LIMIT 20 LOOP
  problems := problems || format('unit %s (%s): the reading named is not that job''s by that model', x.n, x.job_number);
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'grades_load_guard: %', array_to_string(problems[1:40], '; ')
   || CASE WHEN cardinality(problems) > 40 THEN format(' (and %s more)', cardinality(problems) - 40) ELSE '' END;
 END IF;
 PERFORM set_config('grades.before', (SELECT count(*) FROM public.context_grades)::text, true);
 PERFORM set_config('grades.total', (SELECT count(*) FROM grades_units)::text, true);
END $before$;

-- 3. The load: exactly the pasted units.
DO $write$
DECLARE n integer; v_total integer := current_setting('grades.total')::integer;
BEGIN
 INSERT INTO public.context_grades (kind, sample_id, job_id, unit, generation_id, reading_model, item_type, stratum, gated, verdicts,
  grader, as_of, graded_at)
 SELECT g.kind, current_setting('grades.sample_id'), g.job_id, g.unit, g.generation_id, g.reading_model, g.item_type, g.stratum,
  g.gated, g.verdicts, g.grader, g.as_of, g.graded_at
 FROM grades_units g ORDER BY g.n;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> v_total THEN RAISE EXCEPTION 'grades_load_guard: % rows written, % expected', n, v_total; END IF;
END $write$;

-- 4. After: exactly the load, read as the scorecard reads it, and the undo proven (always rolled back).
DO $after$
DECLARE
 x record; n integer; v_expect jsonb := current_setting('grades.expect')::jsonb; v_sample text := current_setting('grades.sample_id');
 v_before integer := current_setting('grades.before')::integer; v_total integer := current_setting('grades.total')::integer;
BEGIN
 FOR x IN SELECT k.kind, (v_expect ->> k.kind)::integer AS want,
                 (SELECT count(*) FROM public.context_grades c WHERE c.kind = k.kind AND c.sample_id = v_sample)::integer AS got,
                 (SELECT s.units + s.optional_units FROM public.context_grade_samples(now()) s WHERE s.kind = k.kind AND s.sample_id = v_sample) AS read
          FROM (VALUES ('ledger'), ('story'), ('agent')) AS k(kind) LOOP
  IF x.got <> x.want THEN RAISE EXCEPTION 'grades_load_guard: % rows of kind % stored, % expected', x.got, x.kind, x.want; END IF;
  IF x.want > 0 AND x.read IS DISTINCT FROM x.want THEN
   RAISE EXCEPTION 'grades_load_guard: context_grade_samples reads % units of kind %, % stored', coalesce(x.read, 0), x.kind, x.want;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.context_grades) <> v_before + v_total THEN
  RAISE EXCEPTION 'grades_load_guard: the table holds % rows, expected % before plus %', (SELECT count(*) FROM public.context_grades), v_before, v_total;
 END IF;
 BEGIN
  DELETE FROM public.context_grades c WHERE c.sample_id = v_sample AND c.kind IN (SELECT DISTINCT g.kind FROM grades_units g);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> v_total OR (SELECT count(*) FROM public.context_grades) <> v_before THEN
   RAISE EXCEPTION 'grades_load_guard: the undo would remove % rows (expected %) and leave % (expected %)', n, v_total,
    (SELECT count(*) FROM public.context_grades), v_before;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0098', MESSAGE = 'undo proven';
 EXCEPTION WHEN SQLSTATE 'P0098' THEN NULL;
 END;
 IF (SELECT count(*) FROM public.context_grades c WHERE c.sample_id = v_sample) <> v_total THEN
  RAISE EXCEPTION 'grades_load_guard: the load did not survive the undo proof';
 END IF;
END $after$;

-- 5. The sample as the scorecard will read it (context_grade_samples; the newest of each kind is context_grades_newest).
SELECT s.kind, s.sample_id, s.newest, current_setting('grades.format') AS pasted_as, current_setting('grades.skipped')::integer AS optional_not_run,
 s.graded_at, s.as_of, s.units, s.passed, s.pass_pct, s.jobs, s.optional_units, s.optional_passed, s.unsafe_lines, s.graders,
 s.tests, s.breakdown, s.readings
FROM public.context_grade_samples(now()) s
WHERE s.sample_id = current_setting('grades.sample_id')
ORDER BY s.kind COLLATE "C";

ROLLBACK;  -- the dry run. The real load, on Marnin's go only: COMMIT in place of this ROLLBACK.
