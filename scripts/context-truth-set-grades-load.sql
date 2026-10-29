-- scripts/context-truth-set-grades-load.sql
-- Load one graded TP-19 truth set (bills, messages or stories) into public.context_truth_set_sets and
-- public.context_truth_set_grades (draft migration 20261029150000, v2). Pair with
-- scripts/context-truth-set-grades-load-undo.sql. Draft, 29 Oct 2026 (v2, after the independent review). NEEDS THE
-- OWNER'S GO to commit. All three kinds load here; no story set goes into row 8's store (context_grades).
--
-- Not run by its author against any real database. As written it ends in ROLLBACK: a dry run that loads, checks,
-- proves the undo, prints the set as context_truth_set_results reads it, and throws it away.
--
-- TWO INPUTS, ids, codes, amounts and counts only:
--   the draw     the draw script's output exactly as it was saved when the set was drawn (secureworks-projects
--                context-system/verify/scripts/tp19-bills-draw-v2.sql, tp19-messages-draw-v2.sql or
--                tp19-stories-draw-v2.sql): the JSON array, or the `supabase db query -o json` wrapper around it
--                ([{"tp19_draw": [...]}]). Every row carries the draw's facts and its digest, so a draw saved short,
--                mixed with another or edited refuses here.
--   the answers  what tp19_sheets.py `answers` wrote from the person's filled sheet: one object per drawn item,
--                {"pos": n, "item_id": "...", "answer": "...", "reason": null|"...", "job_numbers": [...],
--                 "job_amounts_ex": ["120.00", ...], "non_job_bucket": null|"...", "money_items": null|n,
--                 "money_right": null|n, "unsafe_lines": null|n}. Never words: any other key refuses, and the
--                sheet's notes column never reaches this file.
-- The load joins the two itself: the set header and every row take the set, position, item, stratum, sizes and
-- what the system had done from the draw, never from the answers. The person's job numbers are turned into job ids
-- here and compared with the system's in context_truth_set_results (bills and messages were graded blind). It
-- refuses: an answer for a position or item the draw does not hold; a draw not answered whole (a set loads whole or
-- not at all); a draw whose rows disagree about a stratum's size; a job number that names no job or more than one;
-- a holding job (metadata.do_not_schedule read as lower(value) = 'true', as Job Profit reads it) given as an answer, for a bill or a message; a split whose amounts do not
-- fit the bill; a bill that is no longer an ACCPAY bill in our Xero copy; a message that no longer exists; a story
-- whose job or pinned written story no longer exists; and a system job the draw named that no longer exists.
--
-- HOW TO RUN (Supabase SQL editor, or psql as postgres; a write only with the owner's go)
--   1. tp19_sheets.py loadfile fills section 0 (the draw, the answers and the five settings). By hand: paste the
--      draw between the two $draw$ markers and the answers between the two $answers$ markers, and fill the settings.
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
SELECT set_config('truth.rows', '0', true);                   -- the draw's drawn (100 for a first bill or message set, 30 for stories)
SELECT set_config('truth.purpose', 'first', true);            -- first (the first truth set) or weekly (a fresh weekly set)
SELECT set_config('truth.grader', 'grader-1', true);          -- who graded: a grader name, or person:<user id>
SELECT set_config('truth.graded_at', '', true);               -- when the person finished grading, UTC

-- 1. Read the paste into one row per drawn item, every problem at once.
CREATE TEMP TABLE truth_draw (
 pos integer PRIMARY KEY, set_id text, kind text, as_of timestamptz, drawn integer, pool_rows integer, pool_all integer,
 screened integer, excl_count integer, excl_sha256 text, stratum text, stratum_rows integer, stratum_drawn integer,
 item_id text, amount_ex numeric(12,2), system_state text, system_detail text, system_source text, system_job_ids uuid[],
 system_job_ex numeric(12,2)[], system_non_job_ex numeric(12,2), system_holding_job_ids uuid[], story_text_id uuid,
 generation_id uuid, draw_digest text
) ON COMMIT DROP;
CREATE TEMP TABLE truth_answers (
 pos integer PRIMARY KEY, item_id text, answer text, reason text, job_numbers text[], job_amounts_ex numeric(12,2)[],
 non_job_bucket text, money_items integer, money_right integer, unsafe_lines integer, job_ids uuid[]
) ON COMMIT DROP;
DO $read$
DECLARE
 v_draw jsonb; v_ans jsonb; v_digest text; v_rows integer; v_graded timestamptz; x record; n integer;
 v_set text := current_setting('truth.set_id'); v_purpose text := current_setting('truth.purpose');
 v_grader text := current_setting('truth.grader');
 problems text[] := '{}';
 draw_keys constant text[] := ARRAY['set_id', 'kind', 'as_of_utc', 'pos', 'drawn', 'pool_rows', 'pool_all', 'screened',
  'excl_count', 'excl_sha256', 'item_id', 'stratum', 'stratum_rows', 'stratum_drawn', 'amount_ex', 'system_state',
  'system_detail', 'system_source', 'system_job_ids', 'system_job_ex', 'system_non_job_ex', 'system_holding_job_ids',
  'story_text_id', 'generation_id', 'draw_digest'];
 answer_keys constant text[] := ARRAY['pos', 'item_id', 'answer', 'reason', 'job_numbers', 'job_amounts_ex', 'non_job_bucket',
  'money_items', 'money_right', 'unsafe_lines'];
BEGIN
 -- The migration and its tables.
 IF to_regclass('public.context_truth_set_grades') IS NULL OR to_regclass('public.context_truth_set_sets') IS NULL
  OR coalesce(obj_description(to_regclass('public.context_truth_set_grades'), 'pg_class'), '') NOT LIKE 'Context truth-set grades (20261029150000, v2)%'
  OR to_regprocedure('public.context_truth_set_draw_digest(jsonb)') IS NULL
  OR to_regprocedure('public.context_truth_set_results(timestamp with time zone)') IS NULL THEN
  RAISE EXCEPTION 'truth_set_load_guard: migration 20261029150000 (v2) is not live; refusing';
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
 -- Never words: the draw carries exactly the draw script's fields, every one text; the answers only ids, codes,
 -- amounts and counts.
 SELECT count(*) INTO n FROM jsonb_array_elements(v_draw) d
 WHERE jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT (d ?& draw_keys)
    OR EXISTS (SELECT 1 FROM jsonb_each(d) e WHERE NOT e.key = ANY (draw_keys) OR jsonb_typeof(e.value) IS DISTINCT FROM 'string');
 IF n > 0 THEN problems := problems || format('%s draw rows do not carry exactly the v2 draw script''s fields as text (save the draw as it was)', n); END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(v_ans) a
 WHERE jsonb_typeof(a) IS DISTINCT FROM 'object'
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(a) k WHERE NOT k = ANY (answer_keys))
    OR NOT (a ?& answer_keys)
    OR jsonb_typeof(a -> 'pos') IS DISTINCT FROM 'number' OR jsonb_typeof(a -> 'job_numbers') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a -> 'job_amounts_ex') IS DISTINCT FROM 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(a -> 'job_numbers') j WHERE jsonb_typeof(j) IS DISTINCT FROM 'string')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(a -> 'job_amounts_ex') j
               WHERE jsonb_typeof(j) IS DISTINCT FROM 'string' OR j #>> '{}' !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$')
    OR jsonb_typeof(a -> 'item_id') IS DISTINCT FROM 'string' OR jsonb_typeof(a -> 'answer') IS DISTINCT FROM 'string'
    OR jsonb_typeof(a -> 'reason') NOT IN ('string', 'null') OR jsonb_typeof(a -> 'non_job_bucket') NOT IN ('string', 'null')
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['money_items', 'money_right', 'unsafe_lines']) k
               WHERE jsonb_typeof(a -> k) NOT IN ('number', 'null')
                  OR (jsonb_typeof(a -> k) = 'number' AND ((a ->> k)::numeric <> trunc((a ->> k)::numeric) OR (a ->> k)::numeric < 0
                      OR (a ->> k)::numeric > 100000)));
 IF n > 0 THEN problems := problems || format('%s answers are not tp19_sheets.py answers objects (pos, item_id, answer, reason, job_numbers, job_amounts_ex as "123.45" strings, non_job_bucket, money_items, money_right, unsafe_lines)', n); END IF;
 IF cardinality(problems) > 0 THEN RAISE EXCEPTION 'truth_set_load_guard: %', array_to_string(problems, '; '); END IF;

 -- The draw, whole and as it was saved.
 v_digest := public.context_truth_set_draw_digest(v_draw);
 IF v_digest IS NULL THEN problems := problems || 'the draw has no digest: it is empty, misses a field, or its rows disagree about the draw'::text; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(v_draw) d WHERE d ->> 'draw_digest' IS DISTINCT FROM v_digest;
 IF n > 0 THEN problems := problems || format('%s draw rows do not carry the draw''s own digest (saved short, mixed or edited)', n); END IF;
 IF cardinality(problems) > 0 THEN RAISE EXCEPTION 'truth_set_load_guard: %', array_to_string(problems, '; '); END IF;
 BEGIN
  INSERT INTO truth_draw (pos, set_id, kind, as_of, drawn, pool_rows, pool_all, screened, excl_count, excl_sha256, stratum,
   stratum_rows, stratum_drawn, item_id, amount_ex, system_state, system_detail, system_source, system_job_ids, system_job_ex,
   system_non_job_ex, system_holding_job_ids, story_text_id, generation_id, draw_digest)
  SELECT (d ->> 'pos')::integer, d ->> 'set_id', d ->> 'kind', (d ->> 'as_of_utc')::timestamptz, (d ->> 'drawn')::integer,
   (d ->> 'pool_rows')::integer, (d ->> 'pool_all')::integer, (d ->> 'screened')::integer, (d ->> 'excl_count')::integer,
   d ->> 'excl_sha256', d ->> 'stratum', (d ->> 'stratum_rows')::integer, (d ->> 'stratum_drawn')::integer, d ->> 'item_id',
   nullif(d ->> 'amount_ex', '')::numeric(12,2), d ->> 'system_state', d ->> 'system_detail', d ->> 'system_source',
   CASE WHEN d ->> 'system_job_ids' = '' THEN '{}'::uuid[] ELSE string_to_array(d ->> 'system_job_ids', ',')::uuid[] END,
   CASE WHEN d ->> 'system_job_ex' = '' THEN '{}'::numeric(12,2)[] ELSE string_to_array(d ->> 'system_job_ex', ',')::numeric(12,2)[] END,
   (d ->> 'system_non_job_ex')::numeric(12,2),
   CASE WHEN d ->> 'system_holding_job_ids' = '' THEN '{}'::uuid[] ELSE string_to_array(d ->> 'system_holding_job_ids', ',')::uuid[] END,
   nullif(d ->> 'story_text_id', '')::uuid, nullif(d ->> 'generation_id', '')::uuid, d ->> 'draw_digest'
  FROM jsonb_array_elements(v_draw) d;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'truth_set_load_guard: the draw does not read as a TP-19 v2 draw (%)', SQLERRM;
 END;
 SELECT count(*) INTO n FROM truth_draw;
 IF (SELECT min(t.set_id) FROM truth_draw t) IS DISTINCT FROM v_set THEN
  problems := problems || format('the draw is set %s, truth.set_id is %s', (SELECT min(t.set_id) FROM truth_draw t), v_set);
 END IF;
 IF n <> v_rows OR (SELECT min(t.drawn) FROM truth_draw t) <> v_rows OR (SELECT max(t.pos) FROM truth_draw t) <> v_rows OR (SELECT min(t.pos) FROM truth_draw t) <> 1 THEN
  problems := problems || format('the draw holds %s rows at positions %s to %s and says drawn %s; truth.rows is %s',
   n, (SELECT min(t.pos) FROM truth_draw t), (SELECT max(t.pos) FROM truth_draw t), (SELECT min(t.drawn) FROM truth_draw t), v_rows);
 END IF;
 -- Every row of a stratum agrees on its size and draw, and the draw is what the rows hold.
 FOR x IN SELECT t.stratum, count(*) AS c, count(DISTINCT t.stratum_rows) AS r, count(DISTINCT t.stratum_drawn) AS d, min(t.stratum_drawn) AS sd
          FROM truth_draw t GROUP BY t.stratum ORDER BY t.stratum COLLATE "C" LOOP
  IF x.r <> 1 OR x.d <> 1 OR x.sd <> x.c THEN
   problems := problems || format('stratum %s: its rows disagree about its size or draw, or it holds %s rows and says %s', x.stratum, x.c, x.sd);
  END IF;
 END LOOP;
 IF v_graded < (SELECT min(t.as_of) FROM truth_draw t) THEN problems := problems || 'truth.graded_at is before the draw''s as_of'::text; END IF;
 -- The answers: one per drawn position, each naming the draw's item there.
 INSERT INTO truth_answers (pos, item_id, answer, reason, job_numbers, job_amounts_ex, non_job_bucket, money_items, money_right, unsafe_lines)
 SELECT (a ->> 'pos')::integer, a ->> 'item_id', a ->> 'answer', a ->> 'reason',
  ARRAY(SELECT j FROM jsonb_array_elements_text(a -> 'job_numbers') WITH ORDINALITY AS t(j, o) ORDER BY o),
  ARRAY(SELECT j::numeric(12,2) FROM jsonb_array_elements_text(a -> 'job_amounts_ex') WITH ORDINALITY AS t(j, o) ORDER BY o),
  a ->> 'non_job_bucket', (a ->> 'money_items')::integer, (a ->> 'money_right')::integer, (a ->> 'unsafe_lines')::integer
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

-- 2. Before: the items, the jobs and every answer, all problems at once.
DO $before$
DECLARE
 problems text[] := '{}'; x record; v_set text := current_setting('truth.set_id');
 v_kind text := (SELECT min(t.kind) FROM truth_draw t);
BEGIN
 -- A set loads once.
 IF EXISTS (SELECT 1 FROM public.context_truth_set_sets s WHERE s.set_id = v_set)
  OR EXISTS (SELECT 1 FROM public.context_truth_set_grades g WHERE g.set_id = v_set) THEN
  problems := problems || format('set %s is already stored: unload it with the undo first, or draw a new set', v_set);
 END IF;
 -- The items are still what the draw named.
 FOR x IN SELECT d.pos FROM truth_draw d
          WHERE CASE v_kind
           WHEN 'bill' THEN NOT EXISTS (SELECT 1 FROM public.xero_invoices i WHERE i.xero_invoice_id = d.item_id AND i.invoice_type = 'ACCPAY')
           WHEN 'message' THEN d.item_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             OR NOT EXISTS (SELECT 1 FROM public.business_events e WHERE e.id = d.item_id::uuid)
           WHEN 'story' THEN d.item_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR d.story_text_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = d.item_id::uuid)
             OR NOT EXISTS (SELECT 1 FROM public.context_job_story_texts t WHERE t.id = d.story_text_id AND t.job_id = d.item_id::uuid)
           ELSE true END
          ORDER BY d.pos LIMIT 20 LOOP
  problems := problems || format('position %s: the %s is no longer in the database', x.pos,
   CASE v_kind WHEN 'bill' THEN 'ACCPAY bill' WHEN 'message' THEN 'message' ELSE 'job or its pinned written story' END);
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
          WHERE lower(coalesce(j.metadata ->> 'do_not_schedule', '')) = 'true' ORDER BY a.pos LIMIT 20 LOOP
  problems := problems || format('position %s: %s is a holding job, never the right job (answer non_job, no_job or unsure)', x.pos, x.job_number);
 END LOOP;
 UPDATE truth_answers a SET job_ids = ARRAY(SELECT (SELECT j.id FROM public.jobs j WHERE upper(j.job_number) = upper(jn))
                                           FROM unnest(a.job_numbers) WITH ORDINALITY AS t(jn, o) ORDER BY o);
 -- Every answer fits its kind (the table's own checks, named per position before the write).
 FOR x IN SELECT a.pos, a.answer, a.reason FROM truth_answers a JOIN truth_draw d ON d.pos = a.pos
          WHERE NOT coalesce(CASE v_kind
           WHEN 'bill' THEN a.money_items IS NULL AND a.money_right IS NULL AND a.unsafe_lines IS NULL
            AND (a.non_job_bucket IS NULL OR a.non_job_bucket IN ('overhead', 'stock', 'vehicles', 'other_non_job'))
            AND CASE a.answer
             WHEN 'job' THEN a.reason IS NULL AND cardinality(a.job_ids) = 1 AND cardinality(a.job_amounts_ex) = 0 AND a.non_job_bucket IS NULL
             WHEN 'split' THEN a.reason IS NULL AND cardinality(a.job_ids) >= 1
              AND public.context_truth_set_ex_ok(a.job_amounts_ex, cardinality(a.job_ids))
              AND public.context_truth_set_ex_sum(a.job_amounts_ex) <= d.amount_ex
              AND (public.context_truth_set_ex_sum(a.job_amounts_ex) < d.amount_ex) = (a.non_job_bucket IS NOT NULL)
              AND (cardinality(a.job_ids) >= 2 OR a.non_job_bucket IS NOT NULL)
             WHEN 'non_job' THEN a.reason IS NULL AND cardinality(a.job_ids) = 0 AND cardinality(a.job_amounts_ex) = 0 AND a.non_job_bucket IS NOT NULL
             WHEN 'unsure' THEN a.reason IN ('several_jobs', 'not_enough_evidence') AND cardinality(a.job_ids) = 0
              AND cardinality(a.job_amounts_ex) = 0 AND a.non_job_bucket IS NULL
             ELSE false END
           WHEN 'message' THEN a.non_job_bucket IS NULL AND cardinality(a.job_amounts_ex) = 0 AND a.money_items IS NULL
            AND a.money_right IS NULL AND a.unsafe_lines IS NULL
            AND CASE a.answer
             WHEN 'job' THEN a.reason IS NULL AND cardinality(a.job_ids) = 1
             WHEN 'no_job' THEN a.reason IS NULL AND cardinality(a.job_ids) = 0
             WHEN 'unsure' THEN a.reason IN ('several_jobs', 'not_enough_evidence') AND cardinality(a.job_ids) = 0
             ELSE false END
           WHEN 'story' THEN a.answer = 'graded' AND a.reason IS NULL AND cardinality(a.job_ids) = 0 AND cardinality(a.job_amounts_ex) = 0
            AND a.non_job_bucket IS NULL AND a.money_items >= 0 AND a.money_right BETWEEN 0 AND a.money_items AND a.unsafe_lines >= 0
           ELSE false END, false)
             OR a.job_ids IS NULL OR array_position(a.job_ids, NULL) IS NOT NULL
             OR cardinality(a.job_ids) <> (SELECT count(DISTINCT u) FROM unnest(a.job_ids) u)
             OR a.job_ids && d.system_holding_job_ids
          ORDER BY a.pos LIMIT 20 LOOP
  problems := problems || format('position %s: answer %s (reason %s) does not fit a %s set''s rules (a split''s amounts must be one per job, '
   'above 0, in cents, at most the bill, and a bucket exactly when they are less), or names a job twice, a job that does not exist or a holding job',
   x.pos, x.answer, coalesce(x.reason, 'none'), v_kind);
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'truth_set_load_guard: %', array_to_string(problems[1:40], '; ')
   || CASE WHEN cardinality(problems) > 40 THEN format(' (and %s more)', cardinality(problems) - 40) ELSE '' END;
 END IF;
 PERFORM set_config('truth.before', (SELECT count(*) FROM public.context_truth_set_grades)::text, true);
 PERFORM set_config('truth.before_sets', (SELECT count(*) FROM public.context_truth_set_sets)::text, true);
END $before$;

-- 3. The load: the header from the draw, then exactly the draw's rows, each with its answer.
DO $write$
DECLARE n integer; v_rows integer := current_setting('truth.rows')::integer;
BEGIN
 INSERT INTO public.context_truth_set_sets (set_id, kind, purpose, as_of, drawn, draw_digest, pool_rows, pool_all, screened,
  excl_count, excl_sha256, strata, grader, graded_at)
 SELECT min(d.set_id), min(d.kind), current_setting('truth.purpose'), min(d.as_of), min(d.drawn), min(d.draw_digest),
  min(d.pool_rows), min(d.pool_all), min(d.screened), min(d.excl_count), min(d.excl_sha256),
  (SELECT jsonb_object_agg(s.stratum, jsonb_build_object('rows', s.r, 'drawn', s.c) ORDER BY s.stratum COLLATE "C")
   FROM (SELECT t.stratum, min(t.stratum_rows) AS r, count(*) AS c FROM truth_draw t GROUP BY t.stratum) s),
  current_setting('truth.grader'), current_setting('truth.graded_at')::timestamptz
 FROM truth_draw d;
 INSERT INTO public.context_truth_set_grades (set_id, kind, purpose, as_of, drawn, draw_digest, pos, stratum, xero_invoice_id,
  amount_ex, event_id, job_id, story_text_id, generation_id, system_state, system_detail, system_source, system_job_ids,
  system_job_ex, system_non_job_ex, system_holding_job_ids, answer, reason, answer_job_ids, answer_job_ex, non_job_bucket,
  money_items, money_right, unsafe_lines)
 SELECT d.set_id, d.kind, current_setting('truth.purpose'), d.as_of, d.drawn, d.draw_digest, d.pos, d.stratum,
  CASE WHEN d.kind = 'bill' THEN d.item_id END, CASE WHEN d.kind = 'bill' THEN d.amount_ex END,
  CASE WHEN d.kind = 'message' THEN d.item_id::uuid END, CASE WHEN d.kind = 'story' THEN d.item_id::uuid END,
  d.story_text_id, d.generation_id, d.system_state, d.system_detail, d.system_source, d.system_job_ids, d.system_job_ex,
  d.system_non_job_ex, d.system_holding_job_ids, a.answer, a.reason, a.job_ids, a.job_amounts_ex, a.non_job_bucket,
  a.money_items, a.money_right, a.unsafe_lines
 FROM truth_draw d JOIN truth_answers a ON a.pos = d.pos ORDER BY d.pos;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> v_rows THEN RAISE EXCEPTION 'truth_set_load_guard: % rows written, % expected', n, v_rows; END IF;
END $write$;

-- 4. After: exactly the load, read as the results read it, and the undo proven (always rolled back).
DO $after$
DECLARE
 n integer; v_set text := current_setting('truth.set_id'); v_rows integer := current_setting('truth.rows')::integer;
 v_before integer := current_setting('truth.before')::integer; v_before_sets integer := current_setting('truth.before_sets')::integer;
BEGIN
 IF (SELECT count(*) FROM public.context_truth_set_grades g WHERE g.set_id = v_set) <> v_rows
  OR (SELECT count(*) FROM public.context_truth_set_grades) <> v_before + v_rows
  OR (SELECT count(*) FROM public.context_truth_set_sets) <> v_before_sets + 1 THEN
  RAISE EXCEPTION 'truth_set_load_guard: the tables did not grow by exactly the set';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.context_truth_set_results(now()) r WHERE r.set_id = v_set AND r.graded = v_rows AND r.complete) THEN
  RAISE EXCEPTION 'truth_set_load_guard: context_truth_set_results does not read the set whole';
 END IF;
 BEGIN
  DELETE FROM public.context_truth_set_grades g WHERE g.set_id = v_set;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM public.context_truth_set_sets s WHERE s.set_id = v_set;
  IF n <> v_rows OR (SELECT count(*) FROM public.context_truth_set_grades) <> v_before
   OR (SELECT count(*) FROM public.context_truth_set_sets) <> v_before_sets THEN
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
SELECT r.set_id, r.kind, r.purpose, r.as_of, r.graded_at, r.drawn, r.graded, r.complete, r.newest, r.measures
FROM public.context_truth_set_results(now()) r WHERE r.set_id = current_setting('truth.set_id');

ROLLBACK;  -- the dry run. The real load, on the owner's go only: COMMIT in place of this ROLLBACK.
