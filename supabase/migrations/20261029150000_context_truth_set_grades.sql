-- Context truth-set grades (TP-19, 29 Oct 2026; revised after the independent review the same day): where the
-- person-checked bill, message and story truth sets are kept, the digest that proves a saved draw whole, an exact
-- weighted share, and the read that says how each set did. DRAFT: not applied, not merged.
--
-- Why. TP-19 (secureworks-projects context-system/integrated-framework 02-tickets.md, M7) asks for truth sets graded
-- by a person who knows the jobs: 100 bills (the 50 biggest and 50 random), 100 messages (half from customers with
-- several jobs) and 30 stories, and a fresh 50 every week (restarts INT-20, feeds TP-22's weekly scorecard). None
-- of the three may go into an existing store unweighted, because each draw over-samples on purpose (the biggest
-- bills, customers with several jobs, ten stories from each stage of a job):
--  * bills have no graded store at all;
--  * messages have row 3's (context_placement_grades, 20261007070000), whose newest sample IS the scorecard's
--    right-job share: a set half from customers with several jobs would bias it;
--  * stories have row 8's (context_grades kind story, 20261007090000), whose newest sample IS the scorecard's
--    story share, unweighted.
-- So all three sets are kept here, beside rows 3 and 8 and never in them, and every share this read publishes is
-- weighted back to its pool: a stratum's items count stratum_rows / stratum_drawn each (the 50 biggest bills are a
-- census, weight 1; the 50 random stand for the rest of the pool).
--
-- How the sets are drawn (read only: secureworks-projects context-system/verify/scripts/tp19-*-draw-v2.sql) and
-- graded (BLIND for bills and messages: the person never sees the system's answer):
--  bill     the person places the bill from the bill alone, as checks B and E of 08-path-to-trusted-profit.md say:
--           one job; a split (two or more jobs, or a job and a non-job part, with the ex-GST amount on each job);
--           a named non-job bucket; or unsure with a reason. The draw saved what the system had done with the bill:
--           its allocation state (v_bill_allocation_balance: balanced, installer_unconfirmed, a remainder or an
--           over-allocation; or filed not job related; or none), the ex-GST amount it had put on each job and
--           outside any job, and who placed it (rules, ai, person, mixed, unknown or none).
--  message  the person names the job the item belongs to (one job of the customer's, no job, or unsure with a
--           reason) from a card that never shows where it sits. The draw saved the job it sat on, the ladder's
--           placement stratum (context_placement_stratum) and from it who placed it (ai for luna, unknown for other,
--           rules for every other stratum).
--  story    the person grades the job story card (context_job_story at the draw's reading, the unit the grade-kit
--           RUBRIC names) against the job's own records: how many money items it shows, how many are right, and how
--           many unsafe lines (RUBRIC T8).
--
-- What it adds (service role only; nothing for anon or authenticated, proved by the contract):
--  1. context_truth_set_sets: one row per graded set, the draw's header: set id, kind, purpose, draw instant, size,
--     digest, pool sizes (for messages pool_all, every customer-facing item in the window placed or not), screened
--     prefix, exclusion count and sha256, every stratum's size and draw, the grader and when.
--  2. context_truth_set_grades: one row per graded item, tied to its set by a foreign key on (set id, kind, purpose,
--     draw instant, size, digest), so every row of a set agrees with its header. Ids, codes, amounts and counts only,
--     never words. Both tables: RLS on with no policy; service_role reads and inserts, nothing else.
--  3. context_truth_set_draw_digest(draw jsonb): the sha256 of a whole saved draw (tp19-draw-v2), which every draw
--     row carries. The draw scripts compute it inline; the loader recomputes it here.
--  4. context_truth_set_ratio(parts jsonb, mul_num, mul_den): an exact stratum-weighted ratio, rounded DOWN to 4
--     decimals in integer arithmetic.
--  5. context_truth_set_results(as_of): every set stored by as_of, newest of each kind and purpose marked, its
--     measures in two groups: against_08_bar (the share a bar of 08 section 4C or the RUBRIC is read against, named
--     for it) and not_against_a_bar. Every measure is null until the set is graded whole (graded = drawn in every
--     stratum). No bar lives here: the declared measures and bars are in secureworks-projects
--     context-system/verify/evidence/20261029-tp19-truth-sets.md, fixed before any draw.
--  6. Four small helpers the tables' checks call (a CHECK may not hold a subquery): context_truth_set_ids_ok,
--     context_truth_set_ex_ok, context_truth_set_ex_sum, context_truth_set_strata_ok.
--
-- System state is read at DRAW time (the data as the draw ran), not at as_of in the past: a placement made, moved or
-- undone between as_of and the run is what the draw saw. Draw soon after as_of.
--
-- Nothing is written by this migration: no grade, flag, cron job or business row; no existing function is
-- replaced. A finished set is loaded by scripts/context-truth-set-grades-load.sql (guarded, ends in ROLLBACK until
-- the owner's go); scripts/context-truth-set-grades-load-undo.sql removes one.
--
-- Rollback: supabase/rollbacks/20261029150000_context_truth_set_grades_down.sql. It refuses while any set is stored.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard: refuse an object of these names that is not this migration's. Reports every problem at once.
DO $guard$
DECLARE problems text[] := '{}'; x record;
BEGIN
 IF to_regclass('public.jobs') IS NULL THEN problems := problems || 'public.jobs is missing'::text; END IF;
 FOR x IN SELECT c.relname, coalesce(obj_description(c.oid, 'pg_class'), '') AS d FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('context_truth_set_sets', 'context_truth_set_grades') LOOP
  IF x.d NOT LIKE 'Context truth-set grades (20261029150000, v2)%' THEN
   problems := problems || format('public.%s exists and is not this migration''s', x.relname);
  END IF;
 END LOOP;
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'context\_truth\_set\_%' LOOP
  IF x.c NOT LIKE 'Context truth-set grades (20261029150000, v2)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_truth_set_grades_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. Small checks the tables call.
CREATE OR REPLACE FUNCTION public.context_truth_set_ids_ok(p_ids uuid[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT p_ids IS NOT NULL AND array_position(p_ids, NULL) IS NULL
  AND cardinality(p_ids) = (SELECT count(DISTINCT x) FROM unnest(p_ids) x)
$fn$;
COMMENT ON FUNCTION public.context_truth_set_ids_ok(uuid[]) IS
 'Context truth-set grades (20261029150000, v2): true when a job id list holds no null and no id twice.';

CREATE OR REPLACE FUNCTION public.context_truth_set_ex_ok(p_ex numeric[], p_n integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT p_ex IS NOT NULL AND cardinality(p_ex) = p_n AND array_position(p_ex, NULL) IS NULL
  AND NOT EXISTS (SELECT 1 FROM unnest(p_ex) x WHERE x <= 0 OR x <> round(x, 2))
$fn$;
COMMENT ON FUNCTION public.context_truth_set_ex_ok(numeric[], integer) IS
 'Context truth-set grades (20261029150000, v2): true when an amount list (ex GST, one per job) has exactly p_n amounts, each above 0 and in whole cents.';

CREATE OR REPLACE FUNCTION public.context_truth_set_ex_sum(p_ex numeric[])
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT coalesce((SELECT sum(x) FROM unnest(p_ex) x), 0)
$fn$;
COMMENT ON FUNCTION public.context_truth_set_ex_sum(numeric[]) IS
 'Context truth-set grades (20261029150000, v2): the sum of an amount list (0 when empty).';

-- Strata as the header holds them: {"<stratum>": {"rows": R, "drawn": D}, ...}, the stratum names of the kind, each
-- 1 <= drawn <= rows, the drawn adding to the set's drawn and the rows to its screened count; a bill's biggest
-- stratum is a census (rows = drawn).
CREATE OR REPLACE FUNCTION public.context_truth_set_strata_ok(p_kind text, p_strata jsonb, p_drawn integer, p_screened integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT coalesce(jsonb_typeof(p_strata) = 'object' AND (SELECT count(*) FROM jsonb_object_keys(p_strata)) >= 1
  AND NOT EXISTS (
   SELECT 1 FROM jsonb_each(p_strata) e
   WHERE NOT e.key = ANY (CASE p_kind WHEN 'bill' THEN ARRAY['biggest', 'random'] WHEN 'message' THEN ARRAY['multi_job', 'single_job']
                                      WHEN 'story' THEN ARRAY['finished', 'in_work', 'quoting'] ELSE ARRAY[]::text[] END)
      OR jsonb_typeof(e.value) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(e.value)) <> 2
      OR jsonb_typeof(e.value -> 'rows') IS DISTINCT FROM 'number' OR jsonb_typeof(e.value -> 'drawn') IS DISTINCT FROM 'number')
  AND NOT EXISTS (
   SELECT 1 FROM jsonb_each(p_strata) e
   WHERE (e.value ->> 'drawn')::numeric <> trunc((e.value ->> 'drawn')::numeric) OR (e.value ->> 'rows')::numeric <> trunc((e.value ->> 'rows')::numeric)
      OR (e.value ->> 'drawn')::numeric < 1 OR (e.value ->> 'drawn')::numeric > (e.value ->> 'rows')::numeric
      OR (e.key = 'biggest' AND (e.value ->> 'drawn')::numeric <> (e.value ->> 'rows')::numeric))
  AND (SELECT sum((e.value ->> 'drawn')::numeric) FROM jsonb_each(p_strata) e) = p_drawn
  AND (SELECT sum((e.value ->> 'rows')::numeric) FROM jsonb_each(p_strata) e) = p_screened, false)
$fn$;
COMMENT ON FUNCTION public.context_truth_set_strata_ok(text, jsonb, integer, integer) IS
 'Context truth-set grades (20261029150000, v2): true when a set header''s strata are well formed for its kind (bill: biggest, random; message: multi_job, single_job; story: finished, in_work, quoting): each {"rows", "drawn"} whole numbers with 1 <= drawn <= rows, drawn adding to the set''s drawn and rows to its screened count, and a bill''s biggest stratum a census (rows = drawn).';

-- 2. The set header: one row per graded set.
CREATE TABLE IF NOT EXISTS public.context_truth_set_sets (
 set_id text PRIMARY KEY,
 kind text NOT NULL,
 purpose text NOT NULL,
 as_of timestamptz NOT NULL,
 drawn integer NOT NULL,
 draw_digest text NOT NULL,
 -- pool_rows: the items the strata were drawn from. pool_all: message, every customer-facing item in the window,
 -- placed or not (the placed share is pool_rows / pool_all); bill and story, the same as pool_rows. screened: message,
 -- the classed prefix of the pool the strata sizes are counted in; bill and story, the same as pool_rows.
 pool_rows integer NOT NULL,
 pool_all integer NOT NULL,
 screened integer NOT NULL,
 excl_count integer NOT NULL,
 excl_sha256 text NOT NULL,
 strata jsonb NOT NULL,
 grader text NOT NULL,
 graded_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT context_truth_set_sets_kind CHECK (coalesce(CASE kind
  WHEN 'bill' THEN set_id ~ '^tp19-bill-[0-9]{8}t[0-9]{6}z-[a-z0-9-]{1,60}$' AND pool_all = pool_rows AND screened = pool_rows
  WHEN 'message' THEN set_id ~ '^tp19-msg-[0-9]{8}t[0-9]{6}z-[a-z0-9-]{1,60}$' AND pool_rows <= pool_all AND screened <= pool_rows
  WHEN 'story' THEN set_id ~ '^tp19-story-[0-9]{8}t[0-9]{6}z-[a-z0-9-]{1,60}$' AND pool_all = pool_rows AND screened = pool_rows
  ELSE false END, false)),
 CONSTRAINT context_truth_set_sets_purpose CHECK (purpose IN ('first', 'weekly')),
 CONSTRAINT context_truth_set_sets_draw CHECK (coalesce(drawn >= 1 AND drawn <= screened AND excl_count >= 0
  AND draw_digest ~ '^[0-9a-f]{64}$' AND excl_sha256 ~ '^[0-9a-f]{64}$'
  AND public.context_truth_set_strata_ok(kind, strata, drawn, screened), false)),
 CONSTRAINT context_truth_set_sets_grader CHECK (grader ~ '^(person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9._-]{0,63})$'),
 CONSTRAINT context_truth_set_sets_times CHECK (as_of <= graded_at AND graded_at <= created_at + interval '10 minutes'),
 CONSTRAINT context_truth_set_sets_draw_key UNIQUE (set_id, kind, purpose, as_of, drawn, draw_digest)
);
CREATE INDEX IF NOT EXISTS context_truth_set_sets_newest ON public.context_truth_set_sets (kind, purpose, as_of DESC, set_id);
ALTER TABLE public.context_truth_set_sets ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.context_truth_set_sets IS
 'Context truth-set grades (20261029150000, v2): one row per graded TP-19 truth set, its draw''s header: set id, kind (bill, message, story), purpose (first or weekly), draw instant, size, sha256 digest (context_truth_set_draw_digest), pool_rows, pool_all (message: every customer-facing item in the window, placed or not), screened prefix, exclusion count and sha256, strata ({stratum: {rows, drawn}}), grader and when graded. Its items are context_truth_set_grades. Service role reads and inserts; nobody else may do anything.';

-- 3. The grades: one row per graded item.
CREATE TABLE IF NOT EXISTS public.context_truth_set_grades (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 set_id text NOT NULL,
 kind text NOT NULL,
 purpose text NOT NULL,
 as_of timestamptz NOT NULL,
 drawn integer NOT NULL,
 draw_digest text NOT NULL,
 pos integer NOT NULL,
 stratum text NOT NULL,
 -- The item: a bill (its Xero id and ex-GST amount at the draw), a message (business_events row) or a story (the
 -- job, the written story the draw pinned, and the reading it was built on).
 xero_invoice_id text,
 amount_ex numeric(12,2),
 event_id uuid,
 job_id uuid,
 story_text_id uuid,
 generation_id uuid,
 -- What the system had done with it when the draw ran.
 --  bill     system_state placed (system_detail balanced or not_job_related), partial (installer_unconfirmed,
 --           remainder or over) or unplaced (none); system_job_ids with system_job_ex, the ex-GST amount on each;
 --           system_non_job_ex, the part outside any job; system_source rules, ai, person, mixed, unknown or none.
 --  message  system_state placed; system_detail the placement stratum; system_job_ids the job it sat on;
 --           system_source ai (luna), unknown (other) or rules.
 --  story    system_state story, system_detail written, system_job_ids the job, system_source ai.
 -- system_holding_job_ids: which of system_job_ids are holding jobs (metadata.do_not_schedule): never right.
 system_state text NOT NULL,
 system_detail text NOT NULL,
 system_source text NOT NULL,
 system_job_ids uuid[] NOT NULL DEFAULT '{}',
 system_job_ex numeric(12,2)[] NOT NULL DEFAULT '{}',
 system_non_job_ex numeric(12,2) NOT NULL DEFAULT 0,
 system_holding_job_ids uuid[] NOT NULL DEFAULT '{}',
 -- The person.
 --  bill     job (one job, the whole bill); split (answer_job_ids with answer_job_ex, the amount on each, and a
 --           non_job_bucket for any rest); non_job (a bucket); unsure (reason several_jobs or not_enough_evidence).
 --  message  job (the one job it belongs to); no_job; unsure (reason several_jobs or not_enough_evidence).
 --  story    graded: money_items, money_right, unsafe_lines.
 answer text NOT NULL,
 reason text,
 answer_job_ids uuid[] NOT NULL DEFAULT '{}',
 answer_job_ex numeric(12,2)[] NOT NULL DEFAULT '{}',
 non_job_bucket text,
 money_items integer,
 money_right integer,
 unsafe_lines integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT context_truth_set_grades_set FOREIGN KEY (set_id, kind, purpose, as_of, drawn, draw_digest)
  REFERENCES public.context_truth_set_sets (set_id, kind, purpose, as_of, drawn, draw_digest),
 CONSTRAINT context_truth_set_grades_pos CHECK (pos BETWEEN 1 AND drawn),
 CONSTRAINT context_truth_set_grades_lists CHECK (coalesce(public.context_truth_set_ids_ok(system_job_ids)
  AND public.context_truth_set_ids_ok(answer_job_ids) AND public.context_truth_set_ids_ok(system_holding_job_ids)
  AND system_holding_job_ids <@ system_job_ids AND system_non_job_ex >= 0, false)),
 -- A CASE, never an OR, and a null is false: a CHECK passes on null, so every comparison is read through coalesce.
 CONSTRAINT context_truth_set_grades_kind CHECK (coalesce(CASE kind
  WHEN 'bill' THEN xero_invoice_id ~ '^[A-Za-z0-9-]{1,64}$' AND amount_ex > 0 AND event_id IS NULL AND job_id IS NULL
   AND story_text_id IS NULL AND generation_id IS NULL AND stratum IN ('biggest', 'random')
   AND public.context_truth_set_ex_ok(system_job_ex, cardinality(system_job_ids))
   AND system_source IN ('rules', 'ai', 'person', 'mixed', 'unknown', 'none')
   AND CASE system_detail
    WHEN 'none' THEN system_state = 'unplaced' AND cardinality(system_job_ids) = 0 AND system_non_job_ex = 0 AND system_source = 'none'
    WHEN 'not_job_related' THEN system_state = 'placed' AND cardinality(system_job_ids) = 0 AND system_non_job_ex = amount_ex
     AND system_source IN ('ai', 'person')
    WHEN 'balanced' THEN system_state = 'placed' AND (cardinality(system_job_ids) >= 1 OR system_non_job_ex > 0) AND system_source <> 'none'
    WHEN 'installer_unconfirmed' THEN system_state = 'partial' AND (cardinality(system_job_ids) >= 1 OR system_non_job_ex > 0) AND system_source <> 'none'
    WHEN 'remainder' THEN system_state = 'partial' AND (cardinality(system_job_ids) >= 1 OR system_non_job_ex > 0) AND system_source <> 'none'
    WHEN 'over' THEN system_state = 'partial' AND (cardinality(system_job_ids) >= 1 OR system_non_job_ex > 0) AND system_source <> 'none'
    ELSE false END
  WHEN 'message' THEN event_id IS NOT NULL AND xero_invoice_id IS NULL AND amount_ex IS NULL AND job_id IS NULL
   AND story_text_id IS NULL AND generation_id IS NULL AND stratum IN ('multi_job', 'single_job') AND system_state = 'placed'
   AND cardinality(system_job_ids) = 1 AND cardinality(system_job_ex) = 0 AND system_non_job_ex = 0
   AND CASE system_detail
    WHEN 'luna' THEN system_source = 'ai'
    WHEN 'other' THEN system_source = 'unknown'
    WHEN 'single_open' THEN system_source = 'rules' WHEN 'single_line' THEN system_source = 'rules'
    WHEN 'thread' THEN system_source = 'rules' WHEN 'content_ref' THEN system_source = 'rules'
    WHEN 'party' THEN system_source = 'rules' WHEN 'reference' THEN system_source = 'rules'
    WHEN 'payload_job' THEN system_source = 'rules' WHEN 'custody' THEN system_source = 'rules'
    WHEN 'no_words' THEN system_source = 'rules'
    ELSE false END
  WHEN 'story' THEN job_id IS NOT NULL AND story_text_id IS NOT NULL AND xero_invoice_id IS NULL AND amount_ex IS NULL
   AND event_id IS NULL AND stratum IN ('finished', 'in_work', 'quoting') AND system_state = 'story' AND system_detail = 'written'
   AND system_source = 'ai' AND system_job_ids = ARRAY[job_id] AND cardinality(system_job_ex) = 0 AND system_non_job_ex = 0
   AND cardinality(system_holding_job_ids) = 0
  ELSE false END, false)),
 CONSTRAINT context_truth_set_grades_answer CHECK (coalesce(CASE kind
  WHEN 'bill' THEN money_items IS NULL AND money_right IS NULL AND unsafe_lines IS NULL
   AND NOT (answer_job_ids && system_holding_job_ids)
   AND (non_job_bucket IS NULL OR non_job_bucket IN ('overhead', 'stock', 'vehicles', 'other_non_job'))
   AND CASE answer
    WHEN 'job' THEN reason IS NULL AND cardinality(answer_job_ids) = 1 AND cardinality(answer_job_ex) = 0 AND non_job_bucket IS NULL
    WHEN 'split' THEN reason IS NULL AND cardinality(answer_job_ids) >= 1
     AND public.context_truth_set_ex_ok(answer_job_ex, cardinality(answer_job_ids))
     AND public.context_truth_set_ex_sum(answer_job_ex) <= amount_ex
     AND (public.context_truth_set_ex_sum(answer_job_ex) < amount_ex) = (non_job_bucket IS NOT NULL)
     AND (cardinality(answer_job_ids) >= 2 OR non_job_bucket IS NOT NULL)
    WHEN 'non_job' THEN reason IS NULL AND cardinality(answer_job_ids) = 0 AND cardinality(answer_job_ex) = 0 AND non_job_bucket IS NOT NULL
    WHEN 'unsure' THEN reason IN ('several_jobs', 'not_enough_evidence') AND cardinality(answer_job_ids) = 0
     AND cardinality(answer_job_ex) = 0 AND non_job_bucket IS NULL
    ELSE false END
  WHEN 'message' THEN non_job_bucket IS NULL AND cardinality(answer_job_ex) = 0 AND money_items IS NULL AND money_right IS NULL
   AND unsafe_lines IS NULL AND NOT (answer_job_ids && system_holding_job_ids)
   AND CASE answer
    WHEN 'job' THEN reason IS NULL AND cardinality(answer_job_ids) = 1
    WHEN 'no_job' THEN reason IS NULL AND cardinality(answer_job_ids) = 0
    WHEN 'unsure' THEN reason IN ('several_jobs', 'not_enough_evidence') AND cardinality(answer_job_ids) = 0
    ELSE false END
  WHEN 'story' THEN answer = 'graded' AND reason IS NULL AND cardinality(answer_job_ids) = 0 AND cardinality(answer_job_ex) = 0
   AND non_job_bucket IS NULL AND money_items >= 0 AND money_right BETWEEN 0 AND money_items AND unsafe_lines >= 0
  ELSE false END, false)),
 CONSTRAINT context_truth_set_grades_pos_once UNIQUE (set_id, pos)
);
CREATE UNIQUE INDEX IF NOT EXISTS context_truth_set_grades_bill_once ON public.context_truth_set_grades (set_id, xero_invoice_id) WHERE kind = 'bill';
CREATE UNIQUE INDEX IF NOT EXISTS context_truth_set_grades_msg_once ON public.context_truth_set_grades (set_id, event_id) WHERE kind = 'message';
CREATE UNIQUE INDEX IF NOT EXISTS context_truth_set_grades_story_once ON public.context_truth_set_grades (set_id, job_id) WHERE kind = 'story';
CREATE INDEX IF NOT EXISTS context_truth_set_grades_set_key ON public.context_truth_set_grades (set_id, kind, purpose, as_of, drawn, draw_digest);
ALTER TABLE public.context_truth_set_grades ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.context_truth_set_grades IS
 'Context truth-set grades (20261029150000, v2): one row per graded item of one TP-19 set, tied to its header (context_truth_set_sets) by (set id, kind, purpose, draw instant, size, digest). bill: the Xero bill and its ex-GST amount, what the system had done with it when the draw ran (system_state, system_detail from v_bill_allocation_balance, system_job_ids with system_job_ex, system_non_job_ex, system_source rules, ai, person, mixed, unknown or none) and the person''s BLIND answer (job; split with the amount on each job and a bucket for any rest; non_job with a bucket; unsure with a reason). message: the business_events item, the job it sat on, its placement stratum and source, and the person''s BLIND answer (the job it belongs to, no_job, or unsure). story: the job, the pinned written story and reading, and the person''s grade of the story card (money_items, money_right, unsafe_lines). system_holding_job_ids names holding jobs among the system''s; an answer may never name one. Ids, codes, amounts and counts only, never words. Kept beside rows 3 and 8, never in them: each set over-samples on purpose and is read weighted by context_truth_set_results. Drawn by secureworks-projects verify/scripts/tp19-*-draw-v2.sql, loaded whole by scripts/context-truth-set-grades-load.sql with the owner''s go. Service role reads and inserts; nobody else may do anything.';

DO $grants$
DECLARE r text; t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.context_truth_set_sets', 'public.context_truth_set_grades'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', t);
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
   EXECUTE format('GRANT SELECT, INSERT ON TABLE %s TO service_role', t);
  END IF;
 END LOOP;
END $grants$;

-- 4. The digest of a whole saved draw (a JSON array of draw rows, every value text). Header fields must agree on
-- every row; rows are taken in pos order. Null when empty, a field is missing, or the rows disagree about the draw.
CREATE OR REPLACE FUNCTION public.context_truth_set_draw_digest(p_draw jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT CASE WHEN count(*) = 0 OR count(DISTINCT x.h) <> 1 OR bool_or(x.h IS NULL OR x.r IS NULL OR x.pos IS NULL) THEN NULL
  ELSE encode(sha256(convert_to('tp19-draw-v2|' || min(x.h) || '|' || string_agg(x.r, ';' ORDER BY x.pos), 'UTF8')), 'hex') END
 FROM (
  SELECT (d->>'set_id') || '|' || (d->>'kind') || '|' || (d->>'as_of_utc') || '|' || (d->>'drawn') || '|' || (d->>'pool_rows')
          || '|' || (d->>'pool_all') || '|' || (d->>'screened') || '|' || (d->>'excl_count') || '|' || (d->>'excl_sha256') AS h,
         (d->>'pos')::integer AS pos,
         (d->>'pos') || ':' || (d->>'item_id') || ':' || (d->>'stratum') || ':' || (d->>'stratum_rows') || ':'
          || (d->>'stratum_drawn') || ':' || (d->>'amount_ex') || ':' || (d->>'system_state') || ':' || (d->>'system_detail') || ':'
          || (d->>'system_source') || ':' || (d->>'system_job_ids') || ':' || (d->>'system_job_ex') || ':'
          || (d->>'system_non_job_ex') || ':' || (d->>'system_holding_job_ids') || ':' || (d->>'story_text_id') || ':'
          || (d->>'generation_id') AS r
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_draw) = 'array' THEN p_draw ELSE '[]'::jsonb END) d
 ) x
$fn$;
COMMENT ON FUNCTION public.context_truth_set_draw_digest(jsonb) IS
 'Context truth-set grades (20261029150000, v2): the sha256 of a whole TP-19 draw (tp19-draw-v2) from its rows as saved (a JSON array): the header set_id, kind, as_of_utc, drawn, pool_rows, pool_all, screened, excl_count and excl_sha256, then every row''s pos, item_id, stratum, stratum_rows, stratum_drawn, amount_ex, system_state, system_detail, system_source, system_job_ids, system_job_ex, system_non_job_ex, system_holding_job_ids, story_text_id and generation_id in pos order. Every field is read as the draw wrote it (text), so the draw scripts, which compute it inline, and this function agree byte for byte. Null when empty, a field is missing or the rows disagree about the draw.';

-- 5. An exact stratum-weighted ratio. p_parts: [{"rows": R, "drawn": D, "num": N, "den": M}, ...], one per stratum,
-- N and M sums over that stratum's graded items (counts, or dollars in whole cents). Each item stands for R / D of
-- the pool, so the ratio is (sum R N / D) / (sum R M / D) x p_mul_num / p_mul_den, rounded DOWN to 4 decimals. All
-- arithmetic is in integers (cents), so nothing is rounded before the floor. Null when the denominator is 0, a part
-- is malformed, or an amount is not in whole cents.
CREATE OR REPLACE FUNCTION public.context_truth_set_ratio(p_parts jsonb, p_mul_num bigint DEFAULT 1, p_mul_den bigint DEFAULT 1)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
 x jsonb; r numeric; d numeric; a numeric; b numeric;
 nn numeric := 0; nd numeric := 1; dn numeric := 0; dd numeric := 1;
BEGIN
 IF jsonb_typeof(p_parts) IS DISTINCT FROM 'array' OR p_mul_num IS NULL OR p_mul_den IS NULL OR p_mul_num < 0 OR p_mul_den <= 0 THEN
  RETURN NULL;
 END IF;
 FOR x IN SELECT e FROM jsonb_array_elements(p_parts) e LOOP
  IF jsonb_typeof(x -> 'rows') IS DISTINCT FROM 'number' OR jsonb_typeof(x -> 'drawn') IS DISTINCT FROM 'number'
   OR jsonb_typeof(x -> 'num') IS DISTINCT FROM 'number' OR jsonb_typeof(x -> 'den') IS DISTINCT FROM 'number' THEN
   RETURN NULL;
  END IF;
  r := (x ->> 'rows')::numeric; d := (x ->> 'drawn')::numeric;
  a := (x ->> 'num')::numeric * 100; b := (x ->> 'den')::numeric * 100;
  IF d < 1 OR r < 0 OR a < 0 OR b < 0 OR r <> trunc(r) OR d <> trunc(d) OR a <> trunc(a) OR b <> trunc(b) THEN RETURN NULL; END IF;
  -- nn/nd += r a / d; dn/dd += r b / d (exact fractions).
  nn := nn * d + r * a * nd; nd := nd * d;
  dn := dn * d + r * b * dd; dd := dd * d;
 END LOOP;
 IF dn = 0 THEN RETURN NULL; END IF;
 RETURN round(div(nn * dd * p_mul_num * 10000, nd * dn * p_mul_den) / 10000.0, 4);
END $fn$;
COMMENT ON FUNCTION public.context_truth_set_ratio(jsonb, bigint, bigint) IS
 'Context truth-set grades (20261029150000, v2): the exact stratum-weighted ratio (sum rows x num / drawn) / (sum rows x den / drawn) x p_mul_num / p_mul_den over parts [{rows, drawn, num, den}] (num and den counts or dollars in whole cents), computed in integers and rounded DOWN to 4 decimals. Null when the denominator is 0 or a part is malformed.';

-- 6. How each stored set did. Every measure is null until the set is graded whole.
CREATE OR REPLACE FUNCTION public.context_truth_set_results(p_as_of timestamptz DEFAULT now())
RETURNS TABLE (set_id text, kind text, purpose text, as_of timestamptz, graded_at timestamptz, drawn integer, graded integer,
 complete boolean, newest boolean, measures jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH h AS (
  SELECT s.* FROM public.context_truth_set_sets s
  WHERE s.created_at <= coalesce(p_as_of, now()) AND s.graded_at <= coalesce(p_as_of, now())
 ), hs AS (
  -- Every stratum the draw holds, from the header (a stratum with no stored row still counts).
  SELECT h.set_id AS sid, e.key AS st, (e.value ->> 'rows')::bigint AS rows_, (e.value ->> 'drawn')::bigint AS drawn_
  FROM h, jsonb_each(h.strata) e
 ), g0 AS (
  SELECT t.* FROM public.context_truth_set_grades t JOIN h ON h.set_id = t.set_id
  WHERE t.created_at <= coalesce(p_as_of, now())
 ), g1 AS (
  SELECT t.*,
   -- bill: what the system placed (dollars on jobs and outside any job, never more than the bill), and the dollars
   -- the person placed the same way (per job the lesser of the two amounts, never on a holding job; and the lesser
   -- of the two non-job parts). Both count only what the system had put: a bill awaiting its installer
   -- (installer_unconfirmed) or not placed at all counts no dollar on either side.
   CASE WHEN t.kind = 'bill' AND t.system_detail IN ('balanced', 'not_job_related', 'remainder', 'over')
        THEN least(t.amount_ex, coalesce((SELECT sum(x) FROM unnest(t.system_job_ex) x), 0) + t.system_non_job_ex) ELSE 0 END AS placed_ex,
   CASE WHEN t.kind = 'bill' AND t.system_detail IN ('balanced', 'not_job_related', 'remainder', 'over') THEN
     coalesce((SELECT sum(least(s.ex, p.ex))
               FROM unnest(t.system_job_ids, t.system_job_ex) s(id, ex)
               JOIN unnest(t.answer_job_ids, CASE WHEN t.answer = 'job' THEN ARRAY[t.amount_ex] ELSE t.answer_job_ex END) p(id, ex) ON p.id = s.id
               WHERE NOT s.id = ANY (t.system_holding_job_ids)), 0)
     + least(t.system_non_job_ex, CASE t.answer WHEN 'non_job' THEN t.amount_ex
                                   WHEN 'split' THEN t.amount_ex - coalesce((SELECT sum(x) FROM unnest(t.answer_job_ex) x), 0)
                                   ELSE 0 END)
    ELSE 0 END AS right_ex
  FROM g0 t
 ), g AS (
  SELECT t.*,
   CASE t.kind
    WHEN 'bill' THEN t.system_detail IN ('balanced', 'not_job_related')
    WHEN 'message' THEN true ELSE false END AS placed,
   CASE t.kind
    -- bill: placed whole, and the person placed every dollar the same way (same jobs, same amounts, same non-job part).
    WHEN 'bill' THEN t.system_detail IN ('balanced', 'not_job_related') AND cardinality(t.system_holding_job_ids) = 0
     AND t.right_ex >= t.amount_ex - 0.005
    -- message: the person named the job it sat on, and that is not a holding job.
    WHEN 'message' THEN t.answer = 'job' AND t.answer_job_ids[1] = t.system_job_ids[1] AND cardinality(t.system_holding_job_ids) = 0
    ELSE false END AS ok
  FROM g1 t
 ), facts AS (
  -- One (metric, num, den) per item; a null den leaves the item out of that metric.
  SELECT g.set_id AS sid, g.stratum AS st, v.metric, v.num, v.den
  FROM g CROSS JOIN LATERAL (
   SELECT x.metric, x.num, x.den FROM (VALUES
    -- bill. automated = every source but a person (rules, ai, mixed, unknown).
    ('b_placed_share_dollars', g.placed_ex, g.amount_ex),
    ('b_placed_share_count', g.placed::int::numeric, 1::numeric),
    ('b_automated_right_of_placed_dollars', CASE WHEN g.system_source <> 'person' THEN g.right_ex END, CASE WHEN g.system_source <> 'person' THEN g.placed_ex END),
    ('b_automated_right_of_placed_count', CASE WHEN g.system_source <> 'person' AND g.placed THEN g.ok::int END, CASE WHEN g.system_source <> 'person' AND g.placed THEN 1 END),
    ('b_automated_over_5000_right_of_placed_dollars', CASE WHEN g.system_source <> 'person' AND g.amount_ex > 5000 THEN g.right_ex END,
      CASE WHEN g.system_source <> 'person' AND g.amount_ex > 5000 THEN g.placed_ex END),
    ('b_ai_right_of_placed_dollars', CASE WHEN g.system_source = 'ai' THEN g.right_ex END, CASE WHEN g.system_source = 'ai' THEN g.placed_ex END),
    ('b_ai_right_of_placed_count', CASE WHEN g.system_source = 'ai' AND g.placed THEN g.ok::int END, CASE WHEN g.system_source = 'ai' AND g.placed THEN 1 END),
    ('b_ai_over_5000_right_of_placed_dollars', CASE WHEN g.system_source = 'ai' AND g.amount_ex > 5000 THEN g.right_ex END,
      CASE WHEN g.system_source = 'ai' AND g.amount_ex > 5000 THEN g.placed_ex END),
    ('b_rules_right_of_placed_dollars', CASE WHEN g.system_source = 'rules' THEN g.right_ex END, CASE WHEN g.system_source = 'rules' THEN g.placed_ex END),
    ('b_rules_right_of_placed_count', CASE WHEN g.system_source = 'rules' AND g.placed THEN g.ok::int END, CASE WHEN g.system_source = 'rules' AND g.placed THEN 1 END),
    ('b_mixed_right_of_placed_dollars', CASE WHEN g.system_source = 'mixed' THEN g.right_ex END, CASE WHEN g.system_source = 'mixed' THEN g.placed_ex END),
    ('b_unknown_right_of_placed_dollars', CASE WHEN g.system_source = 'unknown' THEN g.right_ex END, CASE WHEN g.system_source = 'unknown' THEN g.placed_ex END),
    ('b_person_right_of_placed_dollars', CASE WHEN g.system_source = 'person' THEN g.right_ex END, CASE WHEN g.system_source = 'person' THEN g.placed_ex END),
    ('b_person_right_of_placed_count', CASE WHEN g.system_source = 'person' AND g.placed THEN g.ok::int END, CASE WHEN g.system_source = 'person' AND g.placed THEN 1 END),
    -- message. right of placed, by source; multi_job alone; right of all = right of placed x the placed share.
    ('m_right_of_placed', g.ok::int::numeric, 1::numeric),
    ('m_right_of_all', g.ok::int::numeric, 1::numeric),
    ('m_ai_right_of_placed', CASE WHEN g.system_source = 'ai' THEN g.ok::int END, CASE WHEN g.system_source = 'ai' THEN 1 END),
    ('m_ai_multi_job_right_of_placed', CASE WHEN g.system_source = 'ai' AND g.stratum = 'multi_job' THEN g.ok::int END,
      CASE WHEN g.system_source = 'ai' AND g.stratum = 'multi_job' THEN 1 END),
    ('m_rules_right_of_placed', CASE WHEN g.system_source = 'rules' THEN g.ok::int END, CASE WHEN g.system_source = 'rules' THEN 1 END),
    ('m_unknown_right_of_placed', CASE WHEN g.system_source = 'unknown' THEN g.ok::int END, CASE WHEN g.system_source = 'unknown' THEN 1 END),
    ('m_multi_job_right_of_placed', CASE WHEN g.stratum = 'multi_job' THEN g.ok::int END, CASE WHEN g.stratum = 'multi_job' THEN 1 END),
    ('m_single_job_right_of_placed', CASE WHEN g.stratum = 'single_job' THEN g.ok::int END, CASE WHEN g.stratum = 'single_job' THEN 1 END),
    -- story.
    ('s_money_items_right', g.money_right::numeric, g.money_items::numeric),
    ('s_stories_with_unsafe_lines', (g.unsafe_lines > 0)::int::numeric, 1::numeric)
   ) x(metric, num, den)
   WHERE left(x.metric, 2) = CASE g.kind WHEN 'bill' THEN 'b_' WHEN 'message' THEN 'm_' ELSE 's_' END AND x.den IS NOT NULL
  ) v
 ), per AS (
  SELECT f.sid, f.metric, f.st, sum(f.num) AS num, sum(f.den) AS den FROM facts f GROUP BY f.sid, f.metric, f.st
 ), metrics AS (
  SELECT DISTINCT f.sid, f.metric FROM facts f
 ), ratios AS (
  -- Every stratum of the draw takes part in every metric (0 / 0 where it has no item of that metric).
  SELECT m.sid, m.metric,
   public.context_truth_set_ratio(
    jsonb_agg(jsonb_build_object('rows', hs.rows_, 'drawn', hs.drawn_, 'num', coalesce(p.num, 0), 'den', coalesce(p.den, 0))
              ORDER BY hs.st COLLATE "C"),
    CASE WHEN m.metric = 'm_right_of_all' THEN max(hh.pool_rows) ELSE 1 END,
    CASE WHEN m.metric = 'm_right_of_all' THEN max(hh.pool_all) ELSE 1 END) AS share,
   sum(coalesce(p.den, 0)) AS den_items
  FROM metrics m JOIN hs ON hs.sid = m.sid JOIN h hh ON hh.set_id = m.sid
  LEFT JOIN per p ON p.sid = m.sid AND p.metric = m.metric AND p.st = hs.st
  GROUP BY m.sid, m.metric
 ), rmap AS (
  SELECT r.sid, jsonb_object_agg(r.metric, r.share ORDER BY r.metric COLLATE "C") AS s,
         jsonb_object_agg(r.metric, r.den_items ORDER BY r.metric COLLATE "C") AS n
  FROM ratios r GROUP BY r.sid
 ), stc AS (
  -- Unweighted counts per stratum (what was drawn, graded and found), for reading, never for a bar.
  SELECT hs.sid, hs.st, hs.rows_, hs.drawn_, count(g.id)::integer AS graded_,
   count(g.id) FILTER (WHERE g.placed)::integer AS placed_n, count(g.id) FILTER (WHERE g.ok)::integer AS ok_n,
   count(g.id) FILTER (WHERE g.answer = 'unsure')::integer AS unsure_n,
   count(g.id) FILTER (WHERE g.kind = 'bill' AND g.system_source = 'person')::integer AS person_n,
   count(g.id) FILTER (WHERE g.kind = 'bill' AND g.system_detail = 'installer_unconfirmed')::integer AS installer_n,
   count(g.id) FILTER (WHERE cardinality(g.system_holding_job_ids) > 0)::integer AS holding_n,
   coalesce(sum(g.amount_ex), 0) AS ex, coalesce(sum(g.placed_ex), 0) AS placed_ex, coalesce(sum(g.right_ex), 0) AS right_ex,
   coalesce(sum(g.money_items), 0)::integer AS money_items_, coalesce(sum(g.money_right), 0)::integer AS money_right_,
   coalesce(sum(g.unsafe_lines), 0)::integer AS unsafe_
  FROM hs LEFT JOIN g ON g.set_id = hs.sid AND g.stratum = hs.st
  GROUP BY hs.sid, hs.st, hs.rows_, hs.drawn_
 ), stj AS (
  SELECT c.sid, bool_and(c.graded_ = c.drawn_) AS strata_whole, sum(c.graded_)::integer AS graded_sum,
   sum(c.unsafe_)::integer AS unsafe_total,
   jsonb_object_agg(c.st, jsonb_build_object('stratum_rows', c.rows_, 'drawn', c.drawn_, 'graded', c.graded_,
    'weight', round(c.rows_::numeric / c.drawn_, 4), 'placed', c.placed_n, 'right', c.ok_n, 'unsure', c.unsure_n,
    'person_placed', c.person_n, 'installer_unconfirmed', c.installer_n, 'on_holding_job', c.holding_n,
    'drawn_ex', c.ex, 'placed_ex', c.placed_ex, 'right_ex', c.right_ex,
    'money_items', c.money_items_, 'money_right', c.money_right_, 'unsafe_lines', c.unsafe_) ORDER BY c.st COLLATE "C") AS strata_
  FROM stc c GROUP BY c.sid
 ), allg AS (
  SELECT g.set_id AS sid, count(*)::integer AS n FROM g GROUP BY g.set_id
 ), ranked AS (
  SELECT h.*, row_number() OVER (PARTITION BY h.kind, h.purpose ORDER BY h.as_of DESC, h.set_id COLLATE "C" DESC) = 1 AS newest_,
   coalesce(a.n, 0) AS graded_n, coalesce(a.n, 0) = h.drawn AND j.strata_whole AND j.graded_sum = h.drawn AS whole_,
   j.strata_, j.unsafe_total, m.s AS sh, m.n AS dn
  FROM h LEFT JOIN allg a ON a.sid = h.set_id JOIN stj j ON j.sid = h.set_id LEFT JOIN rmap m ON m.sid = h.set_id
 )
 SELECT r.set_id, r.kind, r.purpose, r.as_of, r.graded_at, r.drawn, r.graded_n, r.whole_, r.newest_,
  jsonb_build_object('weights', 'each item counts stratum_rows / drawn of its stratum (bill biggest: 1)',
   'strata_unweighted', r.strata_,
   'against_08_bar', CASE WHEN NOT r.whole_ THEN NULL WHEN r.kind = 'bill' THEN jsonb_build_object(
     'ai_right_of_placed_dollars_weighted', r.sh -> 'b_ai_right_of_placed_dollars',
     'ai_over_5000_right_of_placed_dollars_weighted', r.sh -> 'b_ai_over_5000_right_of_placed_dollars',
     'rules_right_of_placed_dollars_weighted', r.sh -> 'b_rules_right_of_placed_dollars')
    WHEN r.kind = 'message' THEN jsonb_build_object(
     'ai_right_of_placed_weighted', r.sh -> 'm_ai_right_of_placed')
    ELSE jsonb_build_object(
     'money_items_right_weighted', r.sh -> 's_money_items_right',
     'unsafe_lines_total', r.unsafe_total) END,
   'not_against_a_bar', CASE WHEN NOT r.whole_ THEN NULL WHEN r.kind = 'bill' THEN jsonb_build_object(
     'placed_share_dollars_weighted', r.sh -> 'b_placed_share_dollars',
     'placed_share_count_weighted', r.sh -> 'b_placed_share_count',
     'automated_right_of_placed_dollars_weighted', r.sh -> 'b_automated_right_of_placed_dollars',
     'automated_right_of_placed_count_weighted', r.sh -> 'b_automated_right_of_placed_count',
     'automated_over_5000_right_of_placed_dollars_weighted', r.sh -> 'b_automated_over_5000_right_of_placed_dollars',
     'ai_right_of_placed_count_weighted', r.sh -> 'b_ai_right_of_placed_count',
     'rules_right_of_placed_count_weighted', r.sh -> 'b_rules_right_of_placed_count',
     'mixed_right_of_placed_dollars_weighted', r.sh -> 'b_mixed_right_of_placed_dollars',
     'unknown_right_of_placed_dollars_weighted', r.sh -> 'b_unknown_right_of_placed_dollars',
     'person_placed_right_of_placed_dollars_weighted_excluded_from_every_share_above', r.sh -> 'b_person_right_of_placed_dollars',
     'person_placed_right_of_placed_count_weighted_excluded_from_every_share_above', r.sh -> 'b_person_right_of_placed_count')
    WHEN r.kind = 'message' THEN jsonb_build_object(
     'right_of_placed_weighted', r.sh -> 'm_right_of_placed',
     'placed_share', public.context_truth_set_ratio(jsonb_build_array(jsonb_build_object('rows', 1, 'drawn', 1, 'num', r.pool_rows, 'den', r.pool_all))),
     'right_of_all_weighted_row3_style_not_row3', r.sh -> 'm_right_of_all',
     'rules_right_of_placed_weighted', r.sh -> 'm_rules_right_of_placed',
     'unknown_right_of_placed_weighted', r.sh -> 'm_unknown_right_of_placed',
     'multi_job_right_of_placed', r.sh -> 'm_multi_job_right_of_placed',
     'single_job_right_of_placed', r.sh -> 'm_single_job_right_of_placed',
     'ai_multi_job_right_of_placed_not_the_tp21_check_bar', r.sh -> 'm_ai_multi_job_right_of_placed',
     'ai_items', r.dn -> 'm_ai_right_of_placed')
    ELSE jsonb_build_object(
     'stories_with_unsafe_lines_weighted', r.sh -> 's_stories_with_unsafe_lines') END)
 FROM ranked r
 ORDER BY r.kind COLLATE "C", r.purpose COLLATE "C", r.as_of DESC, r.set_id COLLATE "C"
$fn$;
COMMENT ON FUNCTION public.context_truth_set_results(timestamptz) IS
 'Context truth-set grades (20261029150000, v2): read only. Every TP-19 set stored by p_as_of (header created and graded by then), newest of each kind and purpose marked, complete when graded = drawn in every stratum of the header. measures: strata_unweighted (per stratum of the header: stratum_rows, drawn, graded, weight, and raw counts and dollars, for reading only), and, only when complete (else null), against_08_bar and not_against_a_bar. Every share is weighted (each item counts stratum_rows / drawn of its stratum; context_truth_set_ratio, exact, rounded down to 4 decimals). bill: placed = the system''s allocation is balanced or filed not job related (v_bill_allocation_balance); placed dollars = what it put on jobs and outside any job (a remainder or over-allocation counts what was put, never more than the bill; installer_unconfirmed counts nothing); right dollars = per job the lesser of the system''s and the person''s amount, plus the lesser of the two non-job parts, never on a holding job; right (count) = placed and every dollar the same. against_08_bar: ai_right_of_placed_dollars_weighted, ai_over_5000_right_of_placed_dollars_weighted, rules_right_of_placed_dollars_weighted. A person''s placement (manual_queue, manual_split, a person-filed non-job bill, an overhead part) is source person and is left out of every automated share; it is reported on its own. message: right = the person named the job it sat on, not a holding job. against_08_bar: ai_right_of_placed_weighted (08 section 4C, Messages, AI). not_against_a_bar includes ai_multi_job_right_of_placed_not_the_tp21_check_bar (TP-21''s 90% is the bar of the second-model check on multi-job customers, not of placement), placed_share (pool_rows / pool_all) and right_of_all_weighted_row3_style_not_row3 (right_of_placed_weighted x placed_share; row 3 reads its own sample). story: against_08_bar money_items_right_weighted and unsafe_lines_total (RUBRIC T8). No bar lives here. Service role only.';

-- 7. Grants: service role only. PUBLIC, anon and authenticated lose EXECUTE (Supabase's default privileges grant it
-- to anon and authenticated directly, so a revoke from PUBLIC alone would leave the results read open to them).
REVOKE ALL ON FUNCTION public.context_truth_set_ids_ok(uuid[]), public.context_truth_set_ex_ok(numeric[], integer), public.context_truth_set_ex_sum(numeric[]),
 public.context_truth_set_strata_ok(text, jsonb, integer, integer), public.context_truth_set_draw_digest(jsonb),
 public.context_truth_set_ratio(jsonb, bigint, bigint), public.context_truth_set_results(timestamptz) FROM PUBLIC;
DO $fgrants$
DECLARE r text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION public.context_truth_set_ids_ok(uuid[]), public.context_truth_set_ex_ok(numeric[], integer), public.context_truth_set_ex_sum(numeric[]),
    public.context_truth_set_strata_ok(text, jsonb, integer, integer), public.context_truth_set_draw_digest(jsonb),
    public.context_truth_set_ratio(jsonb, bigint, bigint), public.context_truth_set_results(timestamptz) FROM %I', r);
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  GRANT EXECUTE ON FUNCTION public.context_truth_set_ids_ok(uuid[]), public.context_truth_set_ex_ok(numeric[], integer), public.context_truth_set_ex_sum(numeric[]),
   public.context_truth_set_strata_ok(text, jsonb, integer, integer), public.context_truth_set_draw_digest(jsonb),
   public.context_truth_set_ratio(jsonb, bigint, bigint), public.context_truth_set_results(timestamptz) TO service_role;
 END IF;
END $fgrants$;
