-- scripts/context-truth-set-grades-load.sql
-- Load one graded TP-19 truth set (bills or messages) into public.context_truth_set_grades (draft migration
-- 20261029150000). Pair with scripts/context-truth-set-grades-load-undo.sql. Draft, 29 Oct 2026. NEEDS THE OWNER'S
-- GO to commit. Stories are not loaded here: a story set loads through scripts/context-grades-load.sql (shape a),
-- which secureworks-projects context-system/verify/scripts/tp19_sheets.py `stories` writes for it.
--
-- Not run by its author against any real database. As written it ends in ROLLBACK: a dry run that loads, checks,
-- proves the undo, prints the set as context_truth_set_results reads it, and throws it away.
--
-- TWO INPUTS, both ids and codes only:
--   the draw     the draw script's output exactly as it was saved when the set was drawn (secureworks-projects
--                context-system/verify/scripts/tp19-bills-draw-v1.sql or tp19-messages-draw-v1.sql): the JSON array,
--                or the `supabase db query -o json` wrapper around it ([{"tp19_draw": [...]}]). Every row carries
--                the draw's facts and its digest, so a draw saved short, mixed with another or edited refuses here.
--   the answers  what tp19_sheets.py `answers` wrote from the person's filled sheet: one object per drawn item,
--                {"pos": n, "item_id": "...", "answer": "...", "reason": null|"...", "job_numbers": [...],
--                 "non_job_bucket": null|"..."}. Never words: any other key refuses, and the sheet's notes column
--                never reaches this file.
-- The load joins the two itself: every row takes its set, position, item, stratum, sizes and the system's answer
-- from the draw, never from the answers. It refuses an answer for a position or item the draw does not hold, a draw
-- that is not answered whole (a set loads whole or not at all), a job number that names no job or more than one,
-- a holding job (metadata.do_not_schedule) given as a job, a bill that is no longer an ACCPAY bill in our Xero
-- copy, a message that no longer exists, and a system job the draw named that no longer exists.
--
-- HOW TO RUN (Supabase SQL editor, or psql as postgres; a write only with the owner's go)
--   1. Paste the draw between the two $draw$ markers and the answers between the two $answers$ markers in
--      section 0, and fill the five settings under them.
--   2. Run the file as written: a dry run. Read the last result.
--   3. Only on the owner's go: the same text with COMMIT in place of the last ROLLBACK, run once.
--   A set loads once; to correct one, unload it with the undo and load it again.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. The set. Paste between the markers, then fill the settings.
CREATE TEMP TABLE truth_paste ON COMMIT DROP AS SELECT $draw$
PASTE THE DRAW HERE
$draw$::text AS draw, $answers$
PASTE THE ANSWERS HERE
$answers$::text AS answers;
SELECT set_config('truth.set_id', 'PASTE-SET-ID', true);      -- the draw's set_id, e.g. tp19-bill-20261102t000000z-b50r50-d180-<seed>
SELECT set_config('truth.rows', '0', true);                   -- the draw's drawn (100 for a first set)
SELECT set_config('truth.purpose', 'first', true);            -- first (the first truth set) or weekly (a fresh weekly set)
SELECT set_config('truth.grader', 'grader-1', true);          -- who graded: a grader name, or person:<user id>
SELECT set_config('truth.graded_at', '', true);               -- when the person finished grading, UTC

-- 1. Read the paste into one row per drawn item, every problem at once.
CREATE TEMP TABLE truth_draw (
 pos integer PRIMARY KEY, set_id text, kind text, as_of timestamptz, drawn integer, pool_rows integer, stratum text,
 stratum_rows integer, stratum_drawn integer, item_id text, amount_ex numeric(12,2), system_state text, system_job_ids uuid[],
 system_non_job_part boolean, system_source text, draw_digest text
) ON COMMIT DROP;
CREATE TEMP TABLE truth_answers (
 pos integer PRIMARY KEY, item_id text, answer text, reason text, job_numbers text[], non_job_bucket text, job_ids uuid[]
) ON COMMIT DROP;
DO $read$
DECLARE
 v_draw jsonb; v_ans jsonb; v_digest text; v_rows integer; v_graded timestamptz; x record; n integer;
 v_set text := current_setting('truth.set_id'); v_purpose text := current_setting('truth.purpose');
 v_grader text := current_setting('truth.grader');
 problems text[] := '{}';
 uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 draw_keys constant text[] := ARRAY['set_id', 'kind', 'as_of_utc', 'pos', 'drawn', 'pool_rows', 'screened', 'excl_count',
  'excl_sha256', 'item_id', 'stratum', 'stratum_rows', 'stratum_drawn', 'amount_ex', 'system_state', 'system_job_ids',
  'system_non_job_part', 'system_source', 'placement_stratum', 'draw_digest'];
 answer_keys constant text[] := ARRAY['pos', 'item_id', 'answer', 'reason', 'job_numbers', 'non_job_bucket'];
BEGIN
 -- The migration and its table.
 IF to_regclass('public.context_truth_set_grades') IS NULL
  OR coalesce(obj_description(to_regclass('public.context_truth_set_grades'), 'pg_class'), '') NOT LIKE 'Context truth-set grades (20261029150000)%'
  OR to_regprocedure('public.context_truth_set_draw_digest(jsonb)') IS NULL
  OR to_regprocedure('public.context_truth_set_results(timestamp with time zone)') IS NULL THEN
  RAISE EXCEPTION 'truth_set_load_guard: migration 20261029150000 is not live; refusing';
 END IF;
 IF (SELECT p.draw FROM truth_paste p) ~ 'PASTE THE DRAW HERE' OR (SELECT p.answers FROM truth_paste p) ~ 'PASTE THE ANSWERS HERE'
  OR v_set = 'PASTE-SET-ID' THEN
  RAISE EXCEPTION 'truth_set_load_guard: paste the draw and the answers and set truth.set_id in section 0';
 END IF;
 BEGIN v_draw := (SELECT p.draw FROM truth_paste p)::jsonb; v_ans := (SELECT p.answers FROM truth_paste p)::jsonb;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'truth_set_load_guard: the draw or the answers is not JSON (%)', SQLERRM;
 END;
 -- The CLI wrapper: [{"tp19_draw": [...]}] (the value may arrive as text).
 IF jsonb_typeof(v_draw) = 'array' AND jsonb_array_length(v_draw) = 1 AND jsonb_typeof(v_draw -> 0) = 'object' AND (v_draw -> 0) ? 'tp19_draw' THEN
  v_draw := CASE WHEN jsonb_typeof(v_draw -> 0 -> 'tp19_draw') = 'string' THEN (v_draw -> 0 ->> 'tp19_draw')::jsonb ELSE v_draw -> 0 -> 'tp19_draw' END;
 END IF;
 IF jsonb_typeof(v_draw) IS DISTINCT FROM 'array' OR jsonb_typeof(v_ans) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'truth_set_load_guard: the draw and the answers must each be one JSON array';
 END IF;
 BEGIN v_rows := current_setting('truth.rows')::integer;
 EXCEPTION WHEN OTHERS THEN v_rows := NULL;
 END;
 BEGIN v_graded := nullif(current_setting('truth.graded_at'), '')::timestamptz;
 EXCEPTION WHEN OTHERS THEN v_graded := NULL;
 END;
 IF v_rows IS NULL OR v_rows < 1 THEN problems := problems || 'truth.rows must be the draw''s drawn, a whole number above 0'::text; END IF;
 IF v_graded IS NULL THEN problems := problems || 'truth.graded_at must be a time'::text;
 ELSIF v_graded > now() THEN problems := problems || 'truth.graded_at is in the future'::text; END IF;
 IF v_purpose NOT IN ('first', 'weekly') THEN problems := problems || 'truth.purpose must be first or weekly'::text; END IF;
 IF v_grader !~ '^(person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9._-]{0,63})$' THEN
  problems := problems || 'truth.grader must be a grader name (grader-1) or person:<user id>'::text;
 END IF;
 -- Never words: the draw carries only the draw script's fields, every one text; the answers only ids and codes.
 SELECT count(*) INTO n FROM jsonb_array_elements(v_draw) d
 WHERE jsonb_typeof(d) IS DISTINCT FROM 'object'
    OR EXISTS (SELECT 1 FROM jsonb_each(d) e WHERE NOT e.key = ANY (draw_keys) OR jsonb_typeof(e.value) IS DISTINCT FROM 'string');
 IF n > 0 THEN problems := problems || format('%s draw rows carry a field that is not the draw script''s, or not as text (save the draw as it was)', n); END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(v_ans) a
 WHERE jsonb_typeof(a) IS DISTINCT FROM 'object'
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(a) k WHERE NOT k = ANY (answer_keys))
    OR NOT (a ?& answer_keys)
    OR jsonb_typeof(a -> 'pos') IS DISTINCT FROM 'number' OR jsonb_typeof(a -> 'job_numbers') IS DISTINCT FROM 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(a -> 'job_numbers') j WHERE jsonb_typeof(j) IS DISTINCT FROM 'string')
    OR jsonb_typeof(a -> 'item_id') IS DISTINCT FROM 'string' OR jsonb_typeof(a -> 'answer') IS DISTINCT FROM 'string'
    OR jsonb_typeof(a -> 'reason') NOT IN ('string', 'null') OR jsonb_typeof(a -> 'non_job_bucket') NOT IN ('string', 'null');
 IF n > 0 THEN problems := problems || format('%s answers are not tp19_sheets.py answers objects (pos, item_id, answer, reason, job_numbers, non_job_bucket)', n); END IF;
 IF cardinality(problems) > 0 THEN RAISE EXCEPTION 'truth_set_load_guard: %', array_to_string(problems, '; '); END IF;

 -- The draw, whole and as it was saved.
 v_digest := public.context_truth_set_draw_digest(v_draw);
 IF v_digest IS NULL THEN problems := problems || 'the draw has no digest: it is empty, misses a field, or its rows disagree about the draw'::text; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(v_draw) d WHERE d ->> 'draw_digest' IS DISTINCT FROM v_digest;
 IF n > 0 THEN problems := problems || format('%s draw rows do not carry the draw''s own digest (saved short, mixed or edited)', n); END IF;
 IF cardinality(problems) > 0 THEN RAISE EXCEPTION 'truth_set_load_guard: %', array_to_string(problems, '; '); END IF;
 BEGIN
  INSERT INTO truth_draw (pos, set_id, kind, as_of, drawn, pool_rows, stratum, stratum_rows, stratum_drawn, item_id, amount_ex,
   system_state, system_job_ids, system_non_job_part, system_source, draw_digest)
  SELECT (d ->> 'pos')::integer, d ->> 'set_id', d ->> 'kind', (d ->> 'as_of_utc')::timestamptz, (d ->> 'drawn')::integer,
   (d ->> 'pool_rows')::integer, d ->> 'stratum', (d ->> 'stratum_rows')::integer, (d ->> 'stratum_drawn')::integer, d ->> 'item_id',
   nullif(d ->> 'amount_ex', '')::numeric(12,2), d ->> 'system_state',
   CASE WHEN d ->> 'system_job_ids' = '' THEN '{}'::uuid[] ELSE string_to_array(d ->> 'system_job_ids', ',')::uuid[] END,
   (d ->> 'system_non_job_part')::boolean, d ->> 'system_source', d ->> 'draw_digest'
  FROM jsonb_array_elements(v_draw) d;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'truth_set_load_guard: the draw does not read as a TP-19 draw (%)', SQLERRM;
 END;
 SELECT count(*) INTO n FROM truth_draw;
 IF (SELECT min(t.set_id) FROM truth_draw t) IS DISTINCT FROM v_set THEN
  problems := problems || format('the draw is set %s, truth.set_id is %s', (SELECT min(t.set_id) FROM truth_draw t), v_set);
 END IF;
 IF (SELECT min(t.kind) FROM truth_draw t) NOT IN ('bill', 'message') THEN
  problems := problems || format('the draw is a %s set: stories load through scripts/context-grades-load.sql', (SELECT min(t.kind) FROM truth_draw t));
 END IF;
 IF n <> v_rows OR (SELECT min(t.drawn) FROM truth_draw t) <> v_rows OR (SELECT max(t.pos) FROM truth_draw t) <> v_rows OR (SELECT min(t.pos) FROM truth_draw t) <> 1 THEN
  problems := problems || format('the draw holds %s rows at positions %s to %s and says drawn %s; truth.rows is %s',
   n, (SELECT min(t.pos) FROM truth_draw t), (SELECT max(t.pos) FROM truth_draw t), (SELECT min(t.drawn) FROM truth_draw t), v_rows);
 END IF;
 IF v_graded < (SELECT min(t.as_of) FROM truth_draw t) THEN problems := problems || 'truth.graded_at is before the draw''s as_of'::text; END IF;
 -- The answers: one per drawn position, each naming the draw's item there.
 INSERT INTO truth_answers (pos, item_id, answer, reason, job_numbers, non_job_bucket)
 SELECT (a ->> 'pos')::integer, a ->> 'item_id', a ->> 'answer', a ->> 'reason',
  ARRAY(SELECT j FROM jsonb_array_elements_text(a -> 'job_numbers') WITH ORDINALITY AS t(j, o) ORDER BY o), a ->> 'non_job_bucket'
 FROM jsonb_array_elements(v_ans) a
 ON CONFLICT (pos) DO NOTHING;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> jsonb_array_length(v_ans) THEN problems := problems || format('%s answers repeat a position', jsonb_array_length(v_ans) - n); END IF;
 FOR x IN SELECT coalesce(d.pos, a.pos) AS pos, d.item_id AS d_item, a.item_id AS a_item FROM truth_draw d FULL JOIN truth_answers a ON a.pos = d.pos
          WHERE d.pos IS NULL OR a.pos IS NULL OR d.item_id IS DISTINCT FROM a.item_id ORDER BY 1 LIMIT 20 LOOP
  problems := problems || CASE WHEN x.d_item IS NULL THEN format('position %s: an answer for a position the draw does not hold', x.pos)
   WHEN x.a_item IS NULL THEN format('position %s: not answered (a set loads whole or not at all)', x.pos)
   ELSE format('position %s: the answer names another item than the draw', x.pos) END;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'truth_set_load_guard: %', array_to_string(problems[1:40], '; ')
   || CASE WHEN cardinality(problems) > 40 THEN format(' (and %s more)', cardinality(problems) - 40) ELSE '' END;
 END IF;
END $read$;

-- 2. Before: the items, the jobs and every verdict, all problems at once.
DO $before$
DECLARE
 problems text[] := '{}'; x record; n integer; v_set text := current_setting('truth.set_id');
 v_kind text := (SELECT min(t.kind) FROM truth_draw t);
BEGIN
 -- A set loads once.
 IF EXISTS (SELECT 1 FROM public.context_truth_set_grades g WHERE g.set_id = v_set) THEN
  problems := problems || format('set %s is already stored: unload it with the undo first, or draw a new set', v_set);
 END IF;
 -- The items are still what the draw named.
 FOR x IN SELECT d.pos FROM truth_draw d
          WHERE CASE v_kind
           WHEN 'bill' THEN NOT EXISTS (SELECT 1 FROM public.xero_invoices i WHERE i.xero_invoice_id = d.item_id AND i.invoice_type = 'ACCPAY')
           ELSE d.item_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             OR NOT EXISTS (SELECT 1 FROM public.business_events e WHERE e.id = d.item_id::uuid) END
          ORDER BY d.pos LIMIT 20 LOOP
  problems := problems || format('position %s: the %s is no longer in the database', x.pos, CASE v_kind WHEN 'bill' THEN 'ACCPAY bill' ELSE 'message' END);
 END LOOP;
 FOR x IN SELECT d.pos FROM truth_draw d, unnest(d.system_job_ids) s(id)
          WHERE NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = s.id) GROUP BY d.pos ORDER BY d.pos LIMIT 20 LOOP
  problems := problems || format('position %s: a job the draw says the system chose no longer exists', x.pos);
 END LOOP;
 -- Job numbers: each names exactly one job, never a holding job.
 FOR x IN SELECT a.pos, jn, (SELECT count(*) FROM public.jobs j WHERE upper(j.job_number) = upper(jn)) AS c
          FROM truth_answers a, unnest(a.job_numbers) jn
          WHERE (SELECT count(*) FROM public.jobs j WHERE upper(j.job_number) = upper(jn)) <> 1 ORDER BY a.pos LIMIT 20 LOOP
  problems := problems || format('position %s: job number %s names %s jobs (one is needed)', x.pos, x.jn, x.c);
 END LOOP;
 FOR x IN SELECT a.pos, j.job_number FROM truth_answers a, unnest(a.job_numbers) jn JOIN public.jobs j ON upper(j.job_number) = upper(jn)
          WHERE coalesce(j.metadata ->> 'do_not_schedule', 'false') = 'true' ORDER BY a.pos LIMIT 20 LOOP
  problems := problems || format('position %s: %s is a holding job, never the right job (answer non_job or unsure)', x.pos, x.job_number);
 END LOOP;
 UPDATE truth_answers a SET job_ids = ARRAY(SELECT (SELECT j.id FROM public.jobs j WHERE upper(j.job_number) = upper(jn))
                                           FROM unnest(a.job_numbers) WITH ORDINALITY AS t(jn, o) ORDER BY o);
 -- Every verdict fits its kind (the table's own check, named per position before the write).
 FOR x IN SELECT a.pos, a.answer, a.reason FROM truth_answers a JOIN truth_draw d ON d.pos = a.pos
          WHERE NOT CASE v_kind
           WHEN 'bill' THEN coalesce(CASE a.answer
             WHEN 'job' THEN a.reason IS NULL AND cardinality(a.job_ids) = 1 AND a.non_job_bucket IS NULL
             WHEN 'split' THEN a.reason IS NULL AND (cardinality(a.job_ids) >= 2 OR (cardinality(a.job_ids) = 1 AND a.non_job_bucket IS NOT NULL))
             WHEN 'non_job' THEN a.reason IS NULL AND cardinality(a.job_ids) = 0 AND a.non_job_bucket IS NOT NULL
             WHEN 'unsure' THEN a.reason IN ('several_jobs', 'not_enough_evidence') AND cardinality(a.job_ids) = 0 AND a.non_job_bucket IS NULL
             ELSE false END AND (a.non_job_bucket IS NULL OR a.non_job_bucket IN ('overhead', 'stock', 'vehicles', 'other_non_job')), false)
           ELSE coalesce(a.non_job_bucket IS NULL AND CASE a.answer
             WHEN 'right' THEN a.reason IS NULL AND cardinality(a.job_ids) = 0
             WHEN 'wrong' THEN CASE a.reason WHEN 'other_job' THEN cardinality(a.job_ids) = 1 AND NOT (a.job_ids[1] = ANY (d.system_job_ids))
                                             WHEN 'no_job' THEN cardinality(a.job_ids) = 0 ELSE false END
             WHEN 'unsure' THEN a.reason IN ('several_jobs', 'not_enough_evidence') AND cardinality(a.job_ids) = 0
             ELSE false END, false) END
             OR a.job_ids IS NULL OR array_position(a.job_ids, NULL) IS NOT NULL
             OR cardinality(a.job_ids) <> (SELECT count(DISTINCT u) FROM unnest(a.job_ids) u)
          ORDER BY a.pos LIMIT 20 LOOP
  problems := problems || format('position %s: answer %s (reason %s) does not fit a %s set''s rules, or names a job twice or a job that does not exist',
   x.pos, x.answer, coalesce(x.reason, 'none'), v_kind);
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'truth_set_load_guard: %', array_to_string(problems[1:40], '; ')
   || CASE WHEN cardinality(problems) > 40 THEN format(' (and %s more)', cardinality(problems) - 40) ELSE '' END;
 END IF;
 PERFORM set_config('truth.before', (SELECT count(*) FROM public.context_truth_set_grades)::text, true);
END $before$;

-- 3. The load: exactly the draw's rows, each with its answer.
DO $write$
DECLARE n integer; v_rows integer := current_setting('truth.rows')::integer;
BEGIN
 INSERT INTO public.context_truth_set_grades (set_id, kind, purpose, as_of, pos, drawn, draw_digest, pool_rows, stratum, stratum_rows,
  stratum_drawn, xero_invoice_id, amount_ex, event_id, system_state, system_job_ids, system_non_job_part, system_source, answer, reason,
  answer_job_ids, non_job_bucket, grader, graded_at)
 SELECT d.set_id, d.kind, current_setting('truth.purpose'), d.as_of, d.pos, d.drawn, d.draw_digest, d.pool_rows, d.stratum, d.stratum_rows,
  d.stratum_drawn, CASE WHEN d.kind = 'bill' THEN d.item_id END, CASE WHEN d.kind = 'bill' THEN d.amount_ex END,
  CASE WHEN d.kind = 'message' THEN d.item_id::uuid END, d.system_state, d.system_job_ids, d.system_non_job_part, d.system_source,
  a.answer, a.reason, a.job_ids, a.non_job_bucket, current_setting('truth.grader'), current_setting('truth.graded_at')::timestamptz
 FROM truth_draw d JOIN truth_answers a ON a.pos = d.pos ORDER BY d.pos;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> v_rows THEN RAISE EXCEPTION 'truth_set_load_guard: % rows written, % expected', n, v_rows; END IF;
END $write$;

-- 4. After: exactly the load, read as the results read it, and the undo proven (always rolled back).
DO $after$
DECLARE
 n integer; v_set text := current_setting('truth.set_id'); v_rows integer := current_setting('truth.rows')::integer;
 v_before integer := current_setting('truth.before')::integer;
BEGIN
 IF (SELECT count(*) FROM public.context_truth_set_grades g WHERE g.set_id = v_set) <> v_rows
  OR (SELECT count(*) FROM public.context_truth_set_grades) <> v_before + v_rows THEN
  RAISE EXCEPTION 'truth_set_load_guard: the table did not grow by exactly the set';
 END IF;
 IF (SELECT r.graded FROM public.context_truth_set_results(now()) r WHERE r.set_id = v_set) IS DISTINCT FROM v_rows THEN
  RAISE EXCEPTION 'truth_set_load_guard: context_truth_set_results does not read the set whole';
 END IF;
 BEGIN
  DELETE FROM public.context_truth_set_grades g WHERE g.set_id = v_set;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> v_rows OR (SELECT count(*) FROM public.context_truth_set_grades) <> v_before THEN
   RAISE EXCEPTION 'truth_set_load_guard: the undo would remove % rows (expected %)', n, v_rows;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0098', MESSAGE = 'undo proven';
 EXCEPTION WHEN SQLSTATE 'P0098' THEN NULL;
 END;
 IF (SELECT count(*) FROM public.context_truth_set_grades g WHERE g.set_id = v_set) <> v_rows THEN
  RAISE EXCEPTION 'truth_set_load_guard: the load did not survive the undo proof';
 END IF;
END $after$;

-- 5. The set as context_truth_set_results reads it.
SELECT r.set_id, r.kind, r.purpose, r.as_of, r.graded_at, r.drawn, r.graded, r.newest, r.measures
FROM public.context_truth_set_results(now()) r WHERE r.set_id = current_setting('truth.set_id');

ROLLBACK;  -- the dry run. The real load, on the owner's go only: COMMIT in place of this ROLLBACK.
