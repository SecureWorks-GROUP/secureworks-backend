-- Load one graded placement sample into context_placement_grades (done
-- definition row 3, 7 Oct 2026). Pair with
-- scripts/context-placement-grades-load-undo.sql. Production: only after
-- migration 20261007070000 is applied.
--
-- Not run by its author. As written it ends in ROLLBACK: a dry run that loads,
-- checks and throws the sample away.
--
-- Two inputs, both ids and codes only (docs/context/placement-grading.md):
--   the draw     the sampler's output exactly as it was saved when the sample
--                was drawn, one JSON array:
--                  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.pos)
--                  FROM public.context_placement_sample(...) s;
--                Every row carries the draw's facts and its digest, so a draw
--                saved short, mixed with another or edited is refused here.
--   the answers  the grader's verdicts, one JSON object per drawn item:
--                  {"event_id": "...", "verdict": "right|wrong|unsure",
--                   "reason": null|"other_job"|"no_job"|"several_jobs"|"not_enough_evidence",
--                   "right_job_id": null|"..."}
--                and, when the grader echoes them, "pos" and "placed_job_id",
--                which must be the draw's. Never words: any other key refuses.
-- The load joins the two itself: every grade row takes its sample, position,
-- job, stratum and counts from the draw, never from the answers. It refuses an
-- answer for an item the draw does not hold, an answer that names another
-- position or job than the draw, and a draw that is not answered whole (a
-- sample of 120 loaded with only its 100 right answers would otherwise read
-- 100 graded, all right). It also refuses a draw item that no longer exists or
-- was not captured in the draw's window. context_placement_grades_newest
-- counts any drawn item without a grade as not right, and returns drawn, so
-- the scorecard can require graded = drawn as well.
--
-- How to run (a write: only with the owner's go, or the authority the rulings
-- register names for loading grades). Paste the draw in place of the first
-- '[]' and the answers in place of the second, set expected_sample_id,
-- expected_rows (the draw's drawn), the grader and graded_at, run this file,
-- read the newest-sample line it prints, then change the final ROLLBACK to
-- COMMIT and run it once. The table takes each sample once: a second load of
-- the same sample refuses; to correct one, unload it with the undo and load it
-- again.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE pg_input ON COMMIT DROP AS
SELECT '[]'::jsonb AS draw, '[]'::jsonb AS answers,
 -- Who graded the sample (grader-1, or person:<user id>) and when the grades were given.
 'grader-1'::text AS grader, '2026-10-07 00:00:00+00'::timestamptz AS graded_at;

CREATE TEMP TABLE pg_draw ON COMMIT DROP AS
SELECT r.* FROM pg_input i, jsonb_to_recordset(CASE WHEN jsonb_typeof(i.draw) = 'array' THEN i.draw ELSE '[]'::jsonb END)
 AS r(sample_id text, population text, as_of timestamptz, pos integer, event_id uuid, placed_job_id uuid, stratum text,
      stratum_rows integer, stratum_drawn integer, drawn integer, population_rows integer, population_all integer, draw_digest text,
      lane text, captured_at timestamptz);

CREATE TEMP TABLE pg_answers ON COMMIT DROP AS
SELECT r.* FROM pg_input i, jsonb_to_recordset(CASE WHEN jsonb_typeof(i.answers) = 'array' THEN i.answers ELSE '[]'::jsonb END)
 AS r(event_id uuid, verdict text, reason text, right_job_id uuid, pos integer, placed_job_id uuid);

DO $check$
DECLARE
 -- The sample (its context_placement_sample id) and how many items its draw holds.
 expected_sample_id constant text := 'placement-cf-YYYYMMDDtHHMMSSz-n120-d30';
 expected_rows constant integer := 120;
 n integer; v_draw jsonb; v_id text; v_days integer; v_size integer; v_as_of timestamptz; v_drawn integer; v_digest text; v_pop text;
 v_rows integer;
BEGIN
 IF to_regclass('public.context_placement_grades') IS NULL OR to_regprocedure('public.context_placement_draw_digest(jsonb)') IS NULL THEN
  RAISE EXCEPTION 'placement_grades_load: migration 20261007070000 is not live; refusing';
 END IF;
 SELECT i.draw INTO v_draw FROM pg_input i;
 IF jsonb_typeof(v_draw) IS DISTINCT FROM 'array' OR jsonb_typeof((SELECT answers FROM pg_input)) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'placement_grades_load: the draw and the answers must each be one JSON array; refusing';
 END IF;
 -- Never words: the draw carries only the sampler's columns, the answers only ids and codes.
 SELECT count(*) INTO n FROM jsonb_array_elements(v_draw) g, jsonb_object_keys(g) k
 WHERE k NOT IN ('sample_id', 'population', 'as_of', 'pos', 'event_id', 'placed_job_id', 'stratum', 'stratum_rows', 'stratum_drawn',
                 'drawn', 'population_rows', 'population_all', 'draw_digest', 'lane', 'captured_at');
 IF n <> 0 THEN RAISE EXCEPTION 'placement_grades_load: % draw keys are not the sampler''s; refusing (save the sampler''s output as it was)', n; END IF;
 SELECT count(*) INTO n FROM pg_input i, jsonb_array_elements(i.answers) g, jsonb_object_keys(g) k
 WHERE k NOT IN ('event_id', 'verdict', 'reason', 'right_job_id', 'pos', 'placed_job_id');
 IF n <> 0 THEN RAISE EXCEPTION 'placement_grades_load: % answer keys are not ids or codes; refusing (never words)', n; END IF;
 -- The draw is one whole draw, exactly as the sampler stamped it.
 SELECT count(*), min(d.sample_id), min(d.population), min(d.as_of), min(d.drawn), min(d.draw_digest)
 INTO v_rows, v_id, v_pop, v_as_of, v_drawn, v_digest FROM pg_draw d;
 IF v_rows = 0 OR (SELECT count(DISTINCT (d.sample_id, d.population, d.as_of, d.drawn, d.draw_digest, d.population_rows, d.population_all))
                   FROM pg_draw d) <> 1 THEN
  RAISE EXCEPTION 'placement_grades_load: the draw is empty or mixes draws; refusing';
 END IF;
 IF v_id IS DISTINCT FROM expected_sample_id OR v_drawn IS DISTINCT FROM expected_rows OR v_rows <> v_drawn THEN
  RAISE EXCEPTION 'placement_grades_load: the draw is sample % with % of % items, expected sample % with %; refusing',
   v_id, v_rows, v_drawn, expected_sample_id, expected_rows;
 END IF;
 IF (SELECT string_agg(d.pos::text, ',' ORDER BY d.pos) FROM pg_draw d) IS DISTINCT FROM
    (SELECT string_agg(g::text, ',' ORDER BY g) FROM generate_series(1, v_drawn) g)
  OR (SELECT count(DISTINCT d.event_id) FROM pg_draw d) <> v_drawn OR EXISTS (SELECT 1 FROM pg_draw d WHERE d.event_id IS NULL) THEN
  RAISE EXCEPTION 'placement_grades_load: the draw does not hold positions 1 to % once each, each a different item; refusing', v_drawn;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_draw d GROUP BY d.stratum HAVING count(DISTINCT d.stratum_rows) <> 1 OR count(DISTINCT d.stratum_drawn) <> 1
            OR count(*) <> min(d.stratum_drawn))
  OR (SELECT sum(s.r) FROM (SELECT DISTINCT d.stratum, d.stratum_rows AS r FROM pg_draw d) s) > (SELECT min(d.population_rows) FROM pg_draw d) THEN
  RAISE EXCEPTION 'placement_grades_load: the draw''s strata do not add up; refusing';
 END IF;
 IF public.context_placement_draw_digest(v_draw) IS DISTINCT FROM v_digest THEN
  RAISE EXCEPTION 'placement_grades_load: the draw does not match its own digest (saved short, mixed or edited); refusing';
 END IF;
 -- The id names the draw: its population, instant, size and window.
 IF v_id !~ '^placement-(cf|xq)-[0-9]{8}t[0-9]{6}z-n[0-9]+-d[0-9]+(-[a-z0-9]{1,16})?$'
  OR substring(v_id FROM '^placement-(cf|xq)-') IS DISTINCT FROM (CASE v_pop WHEN 'customer_facing' THEN 'cf' WHEN 'xero_and_quotes' THEN 'xq' END)
  OR substring(v_id FROM '^placement-(?:cf|xq)-([0-9]{8}t[0-9]{6}z)') <> to_char(v_as_of AT TIME ZONE 'UTC', 'YYYYMMDD"t"HH24MISS"z"') THEN
  RAISE EXCEPTION 'placement_grades_load: sample id % does not name the draw''s population and instant; refusing', v_id;
 END IF;
 v_size := substring(v_id FROM '-n([0-9]+)-')::integer;
 v_days := substring(v_id FROM '-d([0-9]+)')::integer;
 IF v_drawn > v_size THEN RAISE EXCEPTION 'placement_grades_load: the draw holds % items, more than the % its id asked for; refusing', v_drawn, v_size; END IF;
 IF EXISTS (SELECT 1 FROM public.context_placement_grades g WHERE g.sample_id = v_id) THEN
  RAISE EXCEPTION 'placement_grades_load: sample % is already loaded; unload it first to replace it', v_id;
 END IF;
 -- Every drawn item exists and was captured in the draw's window, on a job that exists.
 SELECT count(*) INTO n FROM pg_draw d
 WHERE NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.id = d.event_id
   AND coalesce(b.context_captured_at, b.recorded_at) > v_as_of - make_interval(days => v_days)
   AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of)
  OR NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = d.placed_job_id);
 IF n <> 0 THEN RAISE EXCEPTION 'placement_grades_load: % drawn items no longer exist, were not captured in the draw''s window, or name no job; refusing', n; END IF;
 -- The answers grade the draw whole: one per drawn item, none for anything else, the draw's own position and job.
 IF EXISTS (SELECT 1 FROM pg_answers a WHERE a.event_id IS NULL) OR (SELECT count(DISTINCT a.event_id) FROM pg_answers a) <> (SELECT count(*) FROM pg_answers) THEN
  RAISE EXCEPTION 'placement_grades_load: an answer names no item or an item twice; refusing';
 END IF;
 SELECT count(*) INTO n FROM pg_answers a WHERE NOT EXISTS (SELECT 1 FROM pg_draw d WHERE d.event_id = a.event_id);
 IF n <> 0 THEN RAISE EXCEPTION 'placement_grades_load: % answers grade items the draw does not hold; refusing', n; END IF;
 SELECT count(*) INTO n FROM pg_draw d WHERE NOT EXISTS (SELECT 1 FROM pg_answers a WHERE a.event_id = d.event_id);
 IF n <> 0 THEN
  RAISE EXCEPTION 'placement_grades_load: % drawn items have no answer; a draw loads whole or not at all (refusing)', n;
 END IF;
 SELECT count(*) INTO n FROM pg_answers a JOIN pg_draw d ON d.event_id = a.event_id
 WHERE (a.pos IS NOT NULL AND a.pos <> d.pos) OR (a.placed_job_id IS NOT NULL AND a.placed_job_id <> d.placed_job_id);
 IF n <> 0 THEN RAISE EXCEPTION 'placement_grades_load: % answers name another position or job than the draw; refusing', n; END IF;
END $check$;

INSERT INTO public.context_placement_grades (sample_id, population, as_of, pos, drawn, draw_digest, population_rows, population_all,
 event_id, placed_job_id, stratum, stratum_rows, stratum_drawn, verdict, reason, right_job_id, grader, graded_at)
SELECT d.sample_id, d.population, d.as_of, d.pos, d.drawn, d.draw_digest, d.population_rows, d.population_all, d.event_id,
 d.placed_job_id, d.stratum, d.stratum_rows, d.stratum_drawn, a.verdict, a.reason, a.right_job_id, i.grader, i.graded_at
FROM pg_draw d JOIN pg_answers a ON a.event_id = d.event_id CROSS JOIN pg_input i;

-- What was loaded, how many items moved since the draw, whether the same draw comes out of today's data (it
-- seldom does once placements move; the saved draw is what counts), and how the newest sample reads now.
SELECT l.stratum, l.verdict, coalesce(l.reason, '-') AS reason, count(*) AS rows,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.business_events b WHERE b.id = l.event_id AND b.job_id IS DISTINCT FROM l.placed_job_id))
  AS moved_since_draw
FROM public.context_placement_grades l WHERE l.sample_id = (SELECT min(d.sample_id) FROM pg_draw d)
GROUP BY l.stratum, l.verdict, coalesce(l.reason, '-')
ORDER BY l.stratum COLLATE "C", l.verdict COLLATE "C", coalesce(l.reason, '-') COLLATE "C";
SELECT (SELECT min(d.draw_digest) FROM pg_draw d) = (
  SELECT min(s.draw_digest) FROM public.context_placement_sample((SELECT min(d.as_of) FROM pg_draw d),
   substring((SELECT min(d.sample_id) FROM pg_draw d) FROM '-n([0-9]+)-')::integer,
   substring((SELECT min(d.sample_id) FROM pg_draw d) FROM '-d[0-9]+-([a-z0-9]{1,16})$'),
   substring((SELECT min(d.sample_id) FROM pg_draw d) FROM '-d([0-9]+)')::integer,
   (SELECT min(d.population) FROM pg_draw d)) s) AS same_draw_from_todays_data;
SELECT * FROM public.context_placement_grades_newest(now(), (SELECT min(d.population) FROM pg_draw d));
ROLLBACK;
