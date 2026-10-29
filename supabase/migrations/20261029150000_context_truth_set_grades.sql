-- Context truth-set grades (TP-19, 29 Oct 2026): where the person-checked bill
-- and message truth sets are kept, the digest that proves a saved draw whole,
-- and the read that says how each set did. DRAFT: not applied, not merged.
--
-- Why. TP-19 (secureworks-projects context-system/integrated-framework
-- 02-tickets.md, M7) asks for truth sets graded by a person who knows the
-- jobs: 100 bills (the 50 biggest and 50 random), 100 messages (half from
-- customers with several jobs) and 30 stories, and a fresh 50 every week
-- (restarts INT-20, feeds TP-22's weekly scorecard and CTX-T13). Stories
-- already have a store (context_grades kind story, 20261007090000, loaded by
-- scripts/context-grades-load.sql), so they need nothing here. Bills have no
-- graded store at all. Messages do (context_placement_grades, 20261007070000),
-- but that table is row 3's: its newest sample is the scorecard's right-job
-- share, and a set that takes half its items from customers with several
-- jobs is an over-sample of the hard case, so loading it there would bias
-- row 3. This table keeps both sets beside row 3, never in it.
--
-- How the sets are drawn (read only; secureworks-projects
-- context-system/verify/scripts/tp19-*-draw-v1.sql) and graded:
--  bill     the person places each bill BLIND (sees only the bill as Xero
--           holds it, never the system's answer), as check B and E of
--           08-path-to-trusted-profit.md say: one job, several jobs (a
--           split), a named non-job bucket, or unsure. The draw saved what
--           the system had done with the bill when it was drawn
--           (system_state, system_job_ids, system_source), so the read can
--           score the system against the person, by count and by dollars.
--  message  the person grades the job the item sat on, from
--           context_placement_grade_card (docs/context/placement-grading.md):
--           right; wrong (other_job with the right job, or no_job); unsure
--           (several_jobs or not_enough_evidence). The same verdicts as row 3.
--
-- What it adds (service role only; nothing for anon or authenticated):
--  1. context_truth_set_grades: one row per graded item of one set, tied to
--     its draw (set id, kind, purpose, draw instant, position, size, digest,
--     pool and stratum sizes), the item, the system's answer at the draw, and
--     the person's verdict. Ids, codes, amounts and counts only, never words.
--     RLS on with no policy; service_role reads and inserts, nothing else.
--  2. context_truth_set_draw_digest(draw jsonb): the sha256 of a whole saved
--     draw. The draw scripts compute the same digest inline (they run before
--     this migration exists); the loader recomputes it here and refuses a
--     draw saved short, mixed or edited.
--  3. context_truth_set_ids_ok(uuid[]): no null, no id twice; the table's
--     check on its two job id lists (a CHECK may not hold a subquery).
--  4. context_truth_set_results(as_of): every set stored by as_of with its
--     measures, the newest of each kind and purpose marked. Shares are
--     rounded DOWN to 4 decimals. No bar lives here: 08 section 4C's bars
--     (98% of placed bill dollars, 99% over $5,000; 95% messages, 90% for
--     customers with several jobs) belong to the scorecard that reads this.
--
-- Nothing is written by this migration: no grade, flag, cron job or business
-- row; no existing function is replaced. A finished set is loaded by
-- scripts/context-truth-set-grades-load.sql (guarded, ends in ROLLBACK until
-- the owner's go); scripts/context-truth-set-grades-load-undo.sql removes one.
--
-- Rollback: supabase/rollbacks/20261029150000_context_truth_set_grades_down.sql.
-- It refuses while any grade is stored.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. Reports every problem at once.
DO $guard$
DECLARE problems text[] := '{}'; cols text; x record;
BEGIN
 IF to_regclass('public.jobs') IS NULL THEN problems := problems || 'public.jobs is missing'::text; END IF;
 IF to_regclass('public.context_truth_set_grades') IS NOT NULL THEN
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid = 'public.context_truth_set_grades'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF coalesce(obj_description('public.context_truth_set_grades'::regclass, 'pg_class'), '') NOT LIKE 'Context truth-set grades (20261029150000)%'
   OR cols IS DISTINCT FROM 'id:uuid,set_id:text,kind:text,purpose:text,as_of:timestamp with time zone,pos:integer,drawn:integer,'
     'draw_digest:text,pool_rows:integer,stratum:text,stratum_rows:integer,stratum_drawn:integer,xero_invoice_id:text,'
     'amount_ex:numeric(12,2),event_id:uuid,system_state:text,system_job_ids:uuid[],system_non_job_part:boolean,'
     'system_source:text,answer:text,'
     'reason:text,answer_job_ids:uuid[],non_job_bucket:text,grader:text,graded_at:timestamp with time zone,'
     'created_at:timestamp with time zone' THEN
   problems := problems || format('public.context_truth_set_grades exists and is not this migration''s (columns %s)', cols);
  END IF;
 END IF;
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('context_truth_set_ids_ok', 'context_truth_set_draw_digest',
   'context_truth_set_results') LOOP
  IF x.c NOT LIKE 'Context truth-set grades (20261029150000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_truth_set_grades_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. A job id list is well formed: no null, no id twice. A CHECK may not hold a subquery, so it calls this.
CREATE OR REPLACE FUNCTION public.context_truth_set_ids_ok(p_ids uuid[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT p_ids IS NOT NULL AND array_position(p_ids, NULL) IS NULL
  AND cardinality(p_ids) = (SELECT count(DISTINCT x) FROM unnest(p_ids) x)
$fn$;
COMMENT ON FUNCTION public.context_truth_set_ids_ok(uuid[]) IS
 'Context truth-set grades (20261029150000): true when a job id list holds no null and no id twice (the table''s check on system_job_ids and answer_job_ids).';

-- 2. The table. One row per graded item of one set, with its draw's facts.
CREATE TABLE IF NOT EXISTS public.context_truth_set_grades (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 -- The set as its draw named it (tp19-bill-... or tp19-msg-...), its kind, whether it is the first truth
 -- set or a weekly fresh set, and the instant it was drawn as of.
 set_id text NOT NULL,
 kind text NOT NULL,
 purpose text NOT NULL,
 as_of timestamptz NOT NULL,
 -- The draw: this item's position, how many the draw holds, the draw's digest, the pool it was drawn
 -- from, this item's stratum (bill: biggest or random; message: multi_job or single_job), the stratum's
 -- size (bill: in the pool; message: in the screened prefix of the pool, the weight) and how many the
 -- draw took from it.
 pos integer NOT NULL,
 drawn integer NOT NULL,
 draw_digest text NOT NULL,
 pool_rows integer NOT NULL,
 stratum text NOT NULL,
 stratum_rows integer NOT NULL,
 stratum_drawn integer NOT NULL,
 -- The item: a bill (its Xero id and ex-GST amount at the draw) or a message (business_events row).
 xero_invoice_id text,
 amount_ex numeric(12,2),
 event_id uuid,
 -- What the system had done with it at the draw. bill: job (one job), split (several jobs, or a job and a
 -- non-job part), non_job (filed not job related, or overhead only) or unplaced; system_source rules, ai,
 -- person, mixed or none. message: placed, on system_job_ids[1].
 system_state text NOT NULL,
 system_job_ids uuid[] NOT NULL DEFAULT '{}',
 -- bill: the system had filed part or all of it outside any job (an overhead part, or not job related).
 system_non_job_part boolean NOT NULL DEFAULT false,
 system_source text NOT NULL,
 -- The person's verdict. bill (blind): job, split, non_job or unsure (reason several_jobs or
 -- not_enough_evidence), with the job(s) and the non-job bucket. message: right, wrong (other_job with the
 -- right job, or no_job) or unsure (several_jobs or not_enough_evidence), as row 3 grades.
 answer text NOT NULL,
 reason text,
 answer_job_ids uuid[] NOT NULL DEFAULT '{}',
 non_job_bucket text,
 grader text NOT NULL,
 graded_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT context_truth_set_grades_kind CHECK (coalesce(CASE kind
  WHEN 'bill' THEN set_id ~ '^tp19-bill-[0-9]{8}t[0-9]{6}z-[a-z0-9-]{1,60}$' AND xero_invoice_id ~ '^[A-Za-z0-9-]{1,64}$'
   AND amount_ex IS NOT NULL AND event_id IS NULL AND stratum IN ('biggest', 'random')
   AND system_source IN ('rules', 'ai', 'person', 'mixed', 'none')
   AND CASE system_state
    WHEN 'job' THEN cardinality(system_job_ids) = 1 AND NOT system_non_job_part AND system_source <> 'none'
    WHEN 'split' THEN (cardinality(system_job_ids) >= 2 OR (cardinality(system_job_ids) = 1 AND system_non_job_part))
     AND system_source <> 'none'
    WHEN 'non_job' THEN cardinality(system_job_ids) = 0 AND system_non_job_part
    WHEN 'unplaced' THEN cardinality(system_job_ids) = 0 AND NOT system_non_job_part AND system_source = 'none'
    ELSE false END
  WHEN 'message' THEN set_id ~ '^tp19-msg-[0-9]{8}t[0-9]{6}z-[a-z0-9-]{1,60}$' AND event_id IS NOT NULL AND xero_invoice_id IS NULL
   AND amount_ex IS NULL AND stratum IN ('multi_job', 'single_job') AND system_state = 'placed' AND system_source = 'none'
   AND NOT system_non_job_part
   AND cardinality(system_job_ids) = 1
  ELSE false END, false)),
 CONSTRAINT context_truth_set_grades_purpose CHECK (purpose IN ('first', 'weekly')),
 CONSTRAINT context_truth_set_grades_draw CHECK (drawn >= 1 AND pos BETWEEN 1 AND drawn
  AND stratum_drawn BETWEEN 1 AND drawn AND stratum_drawn <= stratum_rows AND stratum_rows <= pool_rows
  AND drawn <= pool_rows AND draw_digest ~ '^[0-9a-f]{64}$'),
 -- A CASE, never an OR, and a null is false: an unknown answer or a missing reason must refuse (a CHECK passes
 -- on null, so every comparison with a nullable column is read through coalesce).
 CONSTRAINT context_truth_set_grades_answer CHECK (coalesce(CASE kind
  WHEN 'bill' THEN CASE answer
   WHEN 'job' THEN reason IS NULL AND cardinality(answer_job_ids) = 1 AND non_job_bucket IS NULL
   WHEN 'split' THEN reason IS NULL AND (cardinality(answer_job_ids) >= 2
     OR (cardinality(answer_job_ids) = 1 AND non_job_bucket IS NOT NULL))
   WHEN 'non_job' THEN reason IS NULL AND cardinality(answer_job_ids) = 0 AND non_job_bucket IS NOT NULL
   WHEN 'unsure' THEN reason IN ('several_jobs', 'not_enough_evidence') AND cardinality(answer_job_ids) = 0 AND non_job_bucket IS NULL
   ELSE false END
   AND (non_job_bucket IS NULL OR non_job_bucket IN ('overhead', 'stock', 'vehicles', 'other_non_job'))
  WHEN 'message' THEN non_job_bucket IS NULL AND CASE answer
   WHEN 'right' THEN reason IS NULL AND cardinality(answer_job_ids) = 0
   WHEN 'wrong' THEN CASE reason
    WHEN 'other_job' THEN cardinality(answer_job_ids) = 1 AND NOT (answer_job_ids[1] = ANY (system_job_ids))
    WHEN 'no_job' THEN cardinality(answer_job_ids) = 0
    ELSE false END
   WHEN 'unsure' THEN reason IN ('several_jobs', 'not_enough_evidence') AND cardinality(answer_job_ids) = 0
   ELSE false END
  ELSE false END, false)),
 CONSTRAINT context_truth_set_grades_jobs_distinct CHECK (public.context_truth_set_ids_ok(answer_job_ids)
  AND public.context_truth_set_ids_ok(system_job_ids)),
 CONSTRAINT context_truth_set_grades_grader CHECK (grader ~ '^(person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9._-]{0,63})$'),
 CONSTRAINT context_truth_set_grades_times CHECK (as_of <= graded_at AND graded_at <= created_at + interval '10 minutes'),
 CONSTRAINT context_truth_set_grades_pos_once UNIQUE (set_id, pos)
);
CREATE UNIQUE INDEX IF NOT EXISTS context_truth_set_grades_bill_once ON public.context_truth_set_grades (set_id, xero_invoice_id) WHERE kind = 'bill';
CREATE UNIQUE INDEX IF NOT EXISTS context_truth_set_grades_msg_once ON public.context_truth_set_grades (set_id, event_id) WHERE kind = 'message';
CREATE INDEX IF NOT EXISTS context_truth_set_grades_as_of ON public.context_truth_set_grades (kind, purpose, as_of DESC, set_id);
ALTER TABLE public.context_truth_set_grades ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_truth_set_grades FROM PUBLIC;
DO $grants$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON TABLE public.context_truth_set_grades FROM anon; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON TABLE public.context_truth_set_grades FROM authenticated; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  REVOKE ALL ON TABLE public.context_truth_set_grades FROM service_role;
  GRANT SELECT, INSERT ON TABLE public.context_truth_set_grades TO service_role;
 END IF;
END $grants$;
COMMENT ON TABLE public.context_truth_set_grades IS
 'Context truth-set grades (20261029150000): TP-19''s person-checked bill and message sets, one row per graded item, tied to its draw (set id, kind bill or message, purpose first or weekly, draw instant, position, size, sha256 digest, pool and stratum sizes). bill: the Xero bill and its ex-GST amount, what the system had done with it at the draw (system_state job, split, non_job or unplaced; system_job_ids; system_source rules, ai, person, mixed or none) and the person''s BLIND answer (job, split, non_job with a bucket, or unsure with a reason). message: the business_events item, the job it sat on, and the person''s verdict as row 3 grades it (right; wrong other_job or no_job; unsure). Ids, codes, amounts and counts only, never words. Kept beside row 3 (context_placement_grades), never in it: the message set over-samples customers with several jobs. Drawn by secureworks-projects verify/scripts/tp19-*-draw-v1.sql, loaded whole by scripts/context-truth-set-grades-load.sql with the owner''s go, read by context_truth_set_results. Service role reads and inserts; nobody else may do anything.';

-- 3. The digest of a whole saved draw (a JSON array of draw rows). The draw scripts stamp the same value.
-- Header fields must agree on every row; rows are taken in pos order. Null when empty, a field is missing,
-- or the rows disagree about the draw.
CREATE OR REPLACE FUNCTION public.context_truth_set_draw_digest(p_draw jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT CASE WHEN count(*) = 0 OR count(DISTINCT x.h) <> 1 OR bool_or(x.h IS NULL OR x.r IS NULL OR x.pos IS NULL) THEN NULL
  ELSE encode(sha256(convert_to('tp19-draw-v1|' || min(x.h) || '|' || string_agg(x.r, ',' ORDER BY x.pos), 'UTF8')), 'hex') END
 FROM (
  SELECT (d->>'set_id') || '|' || (d->>'kind') || '|' || (d->>'as_of_utc') || '|' || (d->>'drawn') || '|' || (d->>'pool_rows')
          || '|' || (d->>'screened') || '|' || (d->>'excl_count') AS h,
         (d->>'pos')::integer AS pos,
         (d->>'pos') || ':' || (d->>'item_id') || ':' || (d->>'stratum') || ':' || (d->>'stratum_rows') || ':'
          || (d->>'stratum_drawn') || ':' || (d->>'amount_ex') || ':' || (d->>'system_state') || ':'
          || (d->>'system_job_ids') || ':' || (d->>'system_non_job_part') || ':' || (d->>'system_source') AS r
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_draw) = 'array' THEN p_draw ELSE '[]'::jsonb END) d
 ) x
$fn$;
COMMENT ON FUNCTION public.context_truth_set_draw_digest(jsonb) IS
 'Context truth-set grades (20261029150000): the sha256 of a whole TP-19 draw from its rows as saved (a JSON array): set_id, kind, as_of_utc, drawn, pool_rows, screened and excl_count, then every row''s pos, item_id, stratum, stratum_rows, stratum_drawn, amount_ex, system_state, system_job_ids, system_non_job_part and system_source in pos order. Every field is read as the draw wrote it (text), so the draw scripts, which compute it inline before this migration exists, and this function agree byte for byte. Null when empty, a field is missing or the rows disagree about the draw.';

-- 4. How each stored set did. Shares rounded down; a drawn item with no grade is never right.
CREATE OR REPLACE FUNCTION public.context_truth_set_results(p_as_of timestamptz DEFAULT now())
RETURNS TABLE (set_id text, kind text, purpose text, as_of timestamptz, graded_at timestamptz, drawn integer, graded integer,
 newest boolean, measures jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH g AS (
  SELECT t.*,
   -- bill: the system's answer equals the person's (same jobs, and a non-job part on both or neither).
   CASE WHEN t.kind = 'bill' THEN
     t.system_state IN ('job', 'split', 'non_job') AND t.answer IN ('job', 'split', 'non_job')
     AND ARRAY(SELECT unnest(t.system_job_ids) ORDER BY 1) = ARRAY(SELECT unnest(t.answer_job_ids) ORDER BY 1)
     AND t.system_non_job_part = (t.non_job_bucket IS NOT NULL)
    ELSE t.answer = 'right' END AS ok,
   t.kind = 'message' OR t.system_state <> 'unplaced' AS placed
  FROM public.context_truth_set_grades t
  WHERE t.created_at <= coalesce(p_as_of, now()) AND t.graded_at <= coalesce(p_as_of, now())
 ), sets AS (
  SELECT g.set_id AS sid, min(g.kind) AS k, min(g.purpose) AS p, max(g.as_of) AS at_, max(g.graded_at) AS gat, max(g.drawn) AS d,
         count(*)::integer AS n
  FROM g GROUP BY g.set_id
 ), ranked AS (
  SELECT s.*, row_number() OVER (PARTITION BY s.k, s.p ORDER BY s.at_ DESC, s.sid COLLATE "C" DESC) = 1 AS newest_
  FROM sets s
 ), per AS (
  SELECT g.set_id AS sid, g.stratum AS st, max(g.stratum_rows) AS rows_, max(g.stratum_drawn) AS sdrawn, count(*)::integer AS n,
         count(*) FILTER (WHERE g.placed)::integer AS placed_n,
         count(*) FILTER (WHERE g.placed AND g.ok)::integer AS ok_n,
         coalesce(sum(g.amount_ex), 0) AS ex, coalesce(sum(g.amount_ex) FILTER (WHERE g.placed), 0) AS placed_ex,
         coalesce(sum(g.amount_ex) FILTER (WHERE g.placed AND g.ok), 0) AS ok_ex,
         count(*) FILTER (WHERE g.answer = 'wrong')::integer AS wrong_n,
         count(*) FILTER (WHERE g.answer = 'unsure')::integer AS unsure_n,
         count(*) FILTER (WHERE g.kind = 'bill' AND g.amount_ex > 5000)::integer AS over5k_n,
         count(*) FILTER (WHERE g.kind = 'bill' AND g.amount_ex > 5000 AND g.placed)::integer AS over5k_placed,
         coalesce(sum(g.amount_ex) FILTER (WHERE g.kind = 'bill' AND g.amount_ex > 5000 AND g.placed), 0) AS over5k_placed_ex,
         coalesce(sum(g.amount_ex) FILTER (WHERE g.kind = 'bill' AND g.amount_ex > 5000 AND g.placed AND g.ok), 0) AS over5k_ok_ex
  FROM g GROUP BY g.set_id, g.stratum
 ), src1 AS (
  SELECT g.set_id AS sid, g.system_source AS so, count(*) FILTER (WHERE g.placed)::integer AS placed_n,
         count(*) FILTER (WHERE g.placed AND g.ok)::integer AS ok_n,
         coalesce(sum(g.amount_ex) FILTER (WHERE g.placed), 0) AS placed_ex,
         coalesce(sum(g.amount_ex) FILTER (WHERE g.placed AND g.ok), 0) AS ok_ex
  FROM g WHERE g.kind = 'bill' GROUP BY g.set_id, g.system_source
 ), src AS (
  SELECT x.sid, jsonb_object_agg(x.so, jsonb_build_object('placed', x.placed_n, 'right', x.ok_n,
          'placed_ex', x.placed_ex, 'right_ex', x.ok_ex) ORDER BY x.so) AS by_source
  FROM src1 x GROUP BY x.sid
 ), tot AS (
  SELECT p.sid, sum(p.n)::integer AS n, sum(p.placed_n)::integer AS placed_n, sum(p.ok_n)::integer AS ok_n,
         sum(p.ex) AS ex, sum(p.placed_ex) AS placed_ex, sum(p.ok_ex) AS ok_ex, sum(p.wrong_n)::integer AS wrong_n,
         sum(p.unsure_n)::integer AS unsure_n, sum(p.over5k_n)::integer AS over5k_n, sum(p.over5k_placed)::integer AS over5k_placed,
         sum(p.over5k_placed_ex) AS over5k_placed_ex, sum(p.over5k_ok_ex) AS over5k_ok_ex,
         -- message: each stratum's right share weighted by its share of the screened pool.
         CASE WHEN sum(p.rows_) > 0 THEN sum((p.ok_n::numeric / p.sdrawn) * p.rows_) / sum(p.rows_) END AS weighted,
         jsonb_object_agg(p.st, jsonb_build_object('drawn', p.sdrawn, 'graded', p.n, 'stratum_rows', p.rows_,
          'placed', p.placed_n, 'right', p.ok_n, 'wrong', p.wrong_n, 'unsure', p.unsure_n,
          'right_share', round(floor(p.ok_n::numeric / p.sdrawn * 10000) / 10000, 4),
          'placed_ex', p.placed_ex, 'right_ex', p.ok_ex) ORDER BY p.st) AS strata
  FROM per p GROUP BY p.sid
 )
 SELECT r.sid, r.k, r.p, r.at_, r.gat, r.d, r.n, r.newest_,
  CASE r.k WHEN 'bill' THEN jsonb_build_object(
    'placed', t.placed_n, 'right', t.ok_n, 'person_unsure', t.unsure_n,
    'placed_share', round(floor(t.placed_n::numeric / r.d * 10000) / 10000, 4),
    'placed_share_dollars', CASE WHEN t.ex > 0 THEN round(floor(t.placed_ex / t.ex * 10000) / 10000, 4) END,
    'right_of_placed', CASE WHEN t.placed_n > 0 THEN round(floor(t.ok_n::numeric / t.placed_n * 10000) / 10000, 4) END,
    'right_of_placed_dollars', CASE WHEN t.placed_ex > 0 THEN round(floor(t.ok_ex / t.placed_ex * 10000) / 10000, 4) END,
    'over_5000', jsonb_build_object('drawn', t.over5k_n, 'placed', t.over5k_placed,
      'right_of_placed_dollars', CASE WHEN t.over5k_placed_ex > 0 THEN round(floor(t.over5k_ok_ex / t.over5k_placed_ex * 10000) / 10000, 4) END),
    'drawn_ex', t.ex, 'placed_ex', t.placed_ex, 'right_ex', t.ok_ex,
    'by_source', coalesce(s.by_source, '{}'::jsonb), 'strata', t.strata)
  ELSE jsonb_build_object(
    'right', t.ok_n, 'wrong', t.wrong_n, 'unsure', t.unsure_n,
    'right_share', round(floor(t.ok_n::numeric / r.d * 10000) / 10000, 4),
    'weighted_right_share', round(floor(round(coalesce(t.weighted, 0), 10) * 10000) / 10000, 4),
    'strata', t.strata) END
 FROM ranked r JOIN tot t ON t.sid = r.sid LEFT JOIN src s ON s.sid = r.sid
 ORDER BY r.k, r.p, r.at_ DESC, r.sid COLLATE "C"
$fn$;
COMMENT ON FUNCTION public.context_truth_set_results(timestamptz) IS
 'Context truth-set grades (20261029150000): read only. Every TP-19 set stored by p_as_of (created and graded by then), newest of each kind and purpose marked, with measures. bill: placed (the system had placed it: job, split or non_job), right (the system''s answer equals the person''s blind answer: the same jobs, and a non-job part on both or neither; a person unsure is never right), placed_share by count and dollars of the drawn set, right_of_placed by count and dollars, the same for bills over $5,000, by system_source and by stratum (biggest, random). message: right, wrong, unsure, right_share (right / drawn) and weighted_right_share (each stratum''s right / drawn weighted by its share of the screened pool), by stratum (multi_job, single_job). Shares rounded down to 4 decimals; a drawn item with no grade is never right. No bar lives here (08 section 4C). Service role only.';
REVOKE ALL ON FUNCTION public.context_truth_set_results(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.context_truth_set_draw_digest(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.context_truth_set_ids_ok(uuid[]) FROM PUBLIC;
DO $fgrants$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  GRANT EXECUTE ON FUNCTION public.context_truth_set_results(timestamptz) TO service_role;
  GRANT EXECUTE ON FUNCTION public.context_truth_set_draw_digest(jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.context_truth_set_ids_ok(uuid[]) TO service_role;
 END IF;
END $fgrants$;
