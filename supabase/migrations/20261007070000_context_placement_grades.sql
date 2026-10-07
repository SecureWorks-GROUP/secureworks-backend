-- Context placement grades: where graded placement samples are kept, the read
-- that says how the newest sample did, the sampler that draws one, the card a
-- grader reads, and the plan for the misfiles parked on the placeholder job
-- (done definition row 3, 7 Oct 2026).
--
-- Why. Row 3 of the owner's definition of done (5 Oct 2026) is green only when
-- at least 95% of customer-facing items and 95% of Xero and quote items are on
-- the RIGHT job, the rest sit in a review queue with a candidate job, and there
-- are zero known misfiles. The scorecard (20261006032000) can count how many
-- items are on A job, but not whether it is the right one: its
-- right_job_accuracy lane stays red with "no graded placement sample is stored
-- in the database". And its known_misfiles lane read 70 on 7 Oct 2026 with "0
-- the repair can move": every one of the 70 sits on the archived placeholder
-- job SWF-PDF-BUCKET (metadata.do_not_schedule, no contact), a step-1 custody
-- placement the reviewed payload-job repair (20261002170100) never moves,
-- while its own payload names the job the old text-cache backfill guessed.
-- This migration stores the grades, says how the newest sample did, draws a
-- sample, gives the grader the evidence, and plans the misfiles from the
-- ladder's own judgement. It moves nothing.
--
-- What it adds (all service role only; nothing for anon or authenticated):
--  1. context_placement_grades: one row per graded item of one sample, tied to
--     its draw. The draw's facts on every row (the population, the instant, the
--     item's position, how many the draw holds, the draw's digest, the placed
--     population and every item of the population in the window at the draw),
--     the item (event_id), the job it sat on when drawn (placed_job_id), its
--     placement stratum with that stratum's size and draw, the verdict (right,
--     wrong or unsure), a reason code, the right job when the verdict is wrong
--     and a job is right, who graded it and when. Ids, codes and counts only,
--     never words. RLS on with no policy; service_role reads and inserts and
--     nothing else. A finished grade is loaded by
--     scripts/context-placement-grades-load.sql with the owner's go, which
--     takes the saved draw itself, refuses an item not in it and refuses a
--     draw that is not graded whole.
--  2. context_placement_grades_newest(as_of, population): the newest sample of
--     a population (by the instant it was drawn as of) stored by as_of, always
--     one row: drawn, graded and missing (a drawn item with no grade), the
--     counts, right_share (right / drawn: a missing item is never right),
--     weighted_right_share (each stratum's right / drawn weighted by its size
--     at the draw), placed_share (placed items / every item of the population
--     in the window at the draw: the scorecard lane's placed share), and
--     right_of_all = least(right_share, weighted_right_share) x placed_share,
--     the estimated share of ALL the population's items in the window that sat
--     on the right job, which is row 3's own wording; every share rounded DOWN
--     to 4 decimals. No threshold lives here: the bar (graded = drawn, drawn at
--     least 100, right_of_all at least 0.95, for each population) belongs to
--     context_scorecard_policy() and its builder. An unsure verdict is never
--     right.
--  3. context_placement_stratum(status, rule, match_method): the placement
--     stratum of one row (luna, single_open, single_line, thread, content_ref,
--     party, reference, payload_job, custody, no_words, other). Inlinable.
--     context_placement_in_population(population, lane, audience): the one
--     population rule (inlinable): customer_facing is the scorecard's
--     customer_facing lane (texts, calls, call transcripts, emails in and out
--     whose party roles say customer), xero_and_quotes its xero_and_quotes
--     lane (Xero invoices and payments, quotes). context_placement_population
--     (as_of, days, population): that population's PLACED items captured in
--     (as_of - days, as_of], with each row's stratum and lane.
--  4. context_placement_sample(as_of, size, seed, days, population): READ
--     ONLY. Draws size (default 120) placed items of the population,
--     stratified by placement stratum: every stratum gets up to 5 (fewer when
--     it is smaller), the rest is shared in proportion to what each stratum has
--     left (largest remainder, ties by stratum name). The order inside a
--     stratum is md5(sample_id:event id), so one sample_id always draws the
--     same rows from the same data. Every row carries the draw's facts and
--     its digest (context_placement_draw_digest), so a saved draw proves itself
--     whole. Ids, codes and counts only.
--  5. context_placement_grade_card(event_id, placed_job_id): READ ONLY. The
--     evidence a fresh grader reads for one sampled item: its words (first
--     2,000 characters), when it was sent and between whom, the customer (the
--     row's contact, its payload's GHL contact, or the one contact its own
--     email or phone key names, as the ladder's identity step reads it), the
--     job it was placed on (the drawn job when given), the customer's jobs as
--     they stood at the message time, the jobs its words name, the record a
--     Xero or quote item stands for (the invoice's own number, reference,
--     contact, total, date and line words; the quote's version, recipient and
--     the job it was built on), and up to three messages before and after it
--     from the same customer or thread. It never says HOW the ladder placed
--     the item, so the grader judges the job, not the rule. Brief:
--     docs/context/placement-grading.md.
--  6. context_placement_message_twin(e): READ ONLY. The row another writer
--     already saved for the same GHL message as e (its ghl:<id> key, or
--     payload.ghl_message_id or payload.message_id), with the same event type
--     and words, not itself marked a copy, not on a holding job, written as
--     the service role, that stands in for e: placed (admissible to every
--     reader, context_event_source_admissible, and captured) or waiting in
--     the placement queue (no job; admin_bucket, unplaced or pending_luna).
--     Placed first, then a keyed row, then the oldest. The capture copies
--     convention (20261006031000) marks e metadata.duplicate_of = that row.
--  7. context_placement_misfile_plan(): READ ONLY. Every row of
--     context_payload_job_mismatch_rows() with a plan. A row on a holding job
--     (metadata.do_not_schedule) is re-decided by the live rules-on ladder in
--     preview (writes nothing) as it would read with the GHL contact its own
--     payload carries, no job, capture_mode relink, and the payload's job set
--     aside (the writer's guess or inference, never proof). duplicate: its GHL
--     message is already saved by a twin that stands in (6): it is marked a
--     copy of the twin and goes where the twin is (the twin's job, or no job
--     and no queue status while the twin waits in the queue), never a second
--     live copy. move: the ladder places it, by its own rule, on the very job
--     the payload names (two independent signals agree). review: anything
--     else; it goes to the review queue unplaced with the ladder's candidates,
--     the job the ladder chose and the payload's job. Every review row and
--     every copy has its payload job set aside (set_aside_payload_job), so
--     whichever candidate a reviewer later picks is read and is no misfile,
--     and a copy is never one wherever a reopen puts it.
--     leave_not_on_holding_job and leave_error: never touched.
--     scripts/context-placement-misfile-repair.sql applies it with the owner's go.
--  8. context_placement_misfile_counts(as_of): READ ONLY counts for the
--     scorecard: payload mismatch rows (all, on a holding job, by class), rows
--     on a holding job (all, customer-facing in the 30 days before as_of) and
--     live thread bindings to a holding job.
--
-- Reads, never replaces: context_scorecard_lane_of (20261006032000, as live),
-- context_payload_job_mismatch_rows (20261002170100 / 20261005170000),
-- resolve_context_attribution(e, preview, rules_on) (the ladder, L1g as of 7
-- Oct 2026, called only with preview true), context_payload_job_is_guess,
-- context_linked_status, context_event_source_admissible (20261006031000),
-- context_contact_job_timeline, context_ref_jobs, context_job_ref_tokens,
-- context_bucket_text, context_event_text, context_event_identity,
-- context_contact_for_key. No existing function is replaced, and nothing is
-- written: no grade, flag, cron job, trigger, binding or business row.
--
-- Rollback: supabase/rollbacks/20261007070000_context_placement_grades_down.sql.
-- It refuses while any grade is stored, so a grade is never dropped by accident.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. Reports every problem at once.
DO $guard$
DECLARE problems text[] := '{}'; f text; cols text; x record;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.jobs', 'public.business_events', 'public.event_threads'] LOOP
  IF to_regclass(f) IS NULL THEN problems := problems || format('%s is missing', f); END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_lane_of(text,text,text,text,text,jsonb)',
   'public.context_payload_job_mismatch_rows()',
   'public.resolve_context_attribution(public.business_events,boolean,boolean)',
   'public.context_payload_job_is_guess(public.business_events)', 'public.context_linked_status(text)',
   'public.context_event_source_admissible(public.business_events)',
   'public.context_contact_job_timeline(text,timestamp with time zone)', 'public.context_ref_jobs(text[])',
   'public.context_job_ref_tokens(text)', 'public.context_bucket_text(public.business_events)',
   'public.context_event_text(public.business_events)', 'public.context_event_identity(public.business_events)',
   'public.context_contact_for_key(text,text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s is missing', f); END IF;
 END LOOP;
 IF to_regclass('public.event_threads') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_attribute a
   WHERE a.attrelid = 'public.event_threads'::regclass AND a.attname = 'retired_at' AND NOT a.attisdropped) THEN
  problems := problems || 'public.event_threads.retired_at is missing (apply 20261002110000 first)'::text;
 END IF;
 -- The table: absent, or exactly this migration's (a re-apply).
 IF to_regclass('public.context_placement_grades') IS NOT NULL THEN
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid = 'public.context_placement_grades'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF coalesce(obj_description('public.context_placement_grades'::regclass, 'pg_class'), '')
     NOT LIKE 'Context placement grades (20261007070000)%'
   OR cols IS DISTINCT FROM 'id:uuid,sample_id:text,population:text,as_of:timestamp with time zone,pos:integer,drawn:integer,'
     'draw_digest:text,population_rows:integer,population_all:integer,event_id:uuid,placed_job_id:uuid,stratum:text,'
     'stratum_rows:integer,stratum_drawn:integer,verdict:text,reason:text,right_job_id:uuid,grader:text,'
     'graded_at:timestamp with time zone,created_at:timestamp with time zone' THEN
   problems := problems || format('public.context_placement_grades exists and is not this migration''s (columns %s)', cols);
  END IF;
 END IF;
 -- The functions: every overload of these names is absent or this migration's.
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('context_placement_stratum', 'context_placement_in_population',
   'context_placement_population', 'context_placement_draw_digest', 'context_placement_sample',
   'context_placement_grade_card', 'context_placement_grades_newest', 'context_placement_message_twin',
   'context_placement_misfile_plan', 'context_placement_misfile_counts') LOOP
  IF x.c NOT LIKE 'Context placement grades (20261007070000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_placement_grades_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The placement stratum of one row. Inlinable on purpose: plain SQL, no SET.
-- The ladder's status names the step that placed a row; a direct placement is
-- split by what proved it (a reference in the words, the source's own payload
-- job, or the writer's custody).
CREATE OR REPLACE FUNCTION public.context_placement_stratum(p_status text, p_rule text, p_match_method text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT CASE
  WHEN p_status = 'luna' THEN 'luna'
  WHEN p_status IN ('single_open', 'single_line', 'thread', 'content_ref', 'party') THEN p_status
  WHEN p_status = 'direct' AND (p_rule IN ('direct_ref', 'internal_ref') OR p_match_method = 'ladder_ref') THEN 'reference'
  WHEN p_status = 'direct' AND p_rule = 'payload_job' THEN 'payload_job'
  WHEN p_status = 'direct' THEN 'custody'
  WHEN p_status IN ('empty', 'automated') THEN 'no_words'
  ELSE 'other' END
$fn$;
COMMENT ON FUNCTION public.context_placement_stratum(text, text, text) IS
 'Context placement grades (20261007070000): the placement stratum of one business_events row from its attribution_status, metadata.placement_rule and match_method: luna, single_open, single_line, thread, content_ref, party, reference (a job reference in the words), payload_job (the source''s own payload job), custody (the writer''s job), no_words (empty or automated) or other. Inlinable.';

-- 2. The one population rule. Inlinable on purpose: plain SQL, no SET.
CREATE OR REPLACE FUNCTION public.context_placement_in_population(p_population text, p_lane text, p_audience text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT coalesce(CASE p_population
  WHEN 'customer_facing' THEN p_lane IN ('texts', 'calls', 'call_transcripts', 'emails_in', 'emails_out') AND p_audience = 'customer'
  WHEN 'xero_and_quotes' THEN p_lane IN ('xero', 'quotes')
  ELSE false END, false)
$fn$;
COMMENT ON FUNCTION public.context_placement_in_population(text, text, text) IS
 'Context placement grades (20261007070000): whether a row of this scorecard lane (context_scorecard_lane_of) and party-roles audience belongs to a graded population: customer_facing (texts, calls, call transcripts, emails in and out whose audience is customer: the scorecard''s customer_facing lane) or xero_and_quotes (Xero invoices and payments and quotes, any audience: its xero_and_quotes lane). Row 3 has one bar for each. Inlinable.';

-- 3. The table. One row per graded item of one sample, with its draw's facts.
CREATE TABLE IF NOT EXISTS public.context_placement_grades (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 -- The sample, as context_placement_sample named it, its population and the instant it was drawn as of.
 sample_id text NOT NULL,
 population text NOT NULL,
 as_of timestamptz NOT NULL,
 -- The draw: this item's position, how many items the draw holds, the draw's digest
 -- (context_placement_draw_digest of the whole draw), the placed population and every
 -- item of the population in the window at the draw (placed or not).
 pos integer NOT NULL,
 drawn integer NOT NULL,
 draw_digest text NOT NULL,
 population_rows integer NOT NULL,
 population_all integer NOT NULL,
 -- The item graded (a business_events row) and the job it sat on when drawn.
 event_id uuid NOT NULL,
 placed_job_id uuid NOT NULL REFERENCES public.jobs(id),
 -- Its placement stratum, that stratum's size in the population at the draw (for the
 -- weighted share) and how many of the draw came from it.
 stratum text NOT NULL,
 stratum_rows integer NOT NULL,
 stratum_drawn integer NOT NULL,
 -- right: the job it sits on is the job it is about. wrong: it is not (reason other_job with the right job,
 -- or no_job when it belongs to no job). unsure: the records cannot decide (several_jobs, not_enough_evidence).
 verdict text NOT NULL,
 reason text,
 right_job_id uuid REFERENCES public.jobs(id),
 -- Who graded it (grader-1, or person:<user id>) and when.
 grader text NOT NULL,
 graded_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT context_placement_grades_sample_id CHECK (sample_id ~ '^[a-z0-9][a-z0-9._:-]{2,79}$'),
 CONSTRAINT context_placement_grades_population CHECK (CASE population
  WHEN 'customer_facing' THEN sample_id LIKE 'placement-cf-%'
  WHEN 'xero_and_quotes' THEN sample_id LIKE 'placement-xq-%'
  ELSE false END),
 CONSTRAINT context_placement_grades_stratum CHECK (stratum IN ('luna', 'single_open', 'single_line', 'thread', 'content_ref',
  'party', 'reference', 'payload_job', 'custody', 'no_words', 'other')),
 -- The draw's counts nest: an item's place in the draw, its stratum's share of the draw and of the
 -- population, the draw in the placed population, the placed population in all of it.
 CONSTRAINT context_placement_grades_draw CHECK (drawn >= 1 AND pos BETWEEN 1 AND drawn
  AND stratum_drawn BETWEEN 1 AND drawn AND stratum_drawn <= stratum_rows AND stratum_rows <= population_rows
  AND drawn <= population_rows AND population_rows <= population_all AND draw_digest ~ '^[0-9a-f]{32}$'),
 -- A CASE, never an OR of comparisons: an unknown verdict or a missing reason must refuse, not pass as unknown.
 CONSTRAINT context_placement_grades_verdict CHECK (CASE verdict
  WHEN 'right' THEN reason IS NULL AND right_job_id IS NULL
  WHEN 'wrong' THEN CASE reason
   WHEN 'other_job' THEN right_job_id IS NOT NULL AND right_job_id IS DISTINCT FROM placed_job_id
   WHEN 'no_job' THEN right_job_id IS NULL
   ELSE false END
  WHEN 'unsure' THEN CASE reason WHEN 'several_jobs' THEN right_job_id IS NULL WHEN 'not_enough_evidence' THEN right_job_id IS NULL
   ELSE false END
  ELSE false END),
 CONSTRAINT context_placement_grades_grader CHECK (grader ~ '^(person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9._-]{0,63})$'),
 -- Graded after the instant it was drawn as of, and never later than it was stored.
 CONSTRAINT context_placement_grades_times CHECK (as_of <= graded_at AND graded_at <= created_at + interval '10 minutes'),
 CONSTRAINT context_placement_grades_once UNIQUE (sample_id, event_id),
 CONSTRAINT context_placement_grades_pos_once UNIQUE (sample_id, pos)
);
CREATE INDEX IF NOT EXISTS context_placement_grades_as_of ON public.context_placement_grades (population, as_of DESC, sample_id);
CREATE INDEX IF NOT EXISTS context_placement_grades_event ON public.context_placement_grades (event_id);
CREATE INDEX IF NOT EXISTS context_placement_grades_placed_job ON public.context_placement_grades (placed_job_id);
CREATE INDEX IF NOT EXISTS context_placement_grades_right_job ON public.context_placement_grades (right_job_id) WHERE right_job_id IS NOT NULL;
ALTER TABLE public.context_placement_grades ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_placement_grades FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.context_placement_grades TO service_role;
COMMENT ON TABLE public.context_placement_grades IS
 'Context placement grades (20261007070000): one row per graded item of one placement sample (done definition row 3), tied to its draw: the population (customer_facing or xero_and_quotes), the draw instant, the item''s position, how many items the draw holds, the draw''s digest (context_placement_draw_digest), the placed population and every item of the population in the window at the draw; the item (event_id), the job it sat on when drawn (placed_job_id), its stratum with that stratum''s size and draw; the verdict (right; wrong with reason other_job and the right job, or no_job; unsure with reason several_jobs or not_enough_evidence), the grader and when. Ids, codes and counts only, never words. Drawn by context_placement_sample, graded from context_placement_grade_card (docs/context/placement-grading.md), loaded whole from the saved draw by scripts/context-placement-grades-load.sql with the owner''s go; the newest sample of a population is context_placement_grades_newest. Service role reads and inserts; nobody else may do anything.';

-- 4. The population: a scorecard lane's placed items.
CREATE OR REPLACE FUNCTION public.context_placement_population(p_as_of timestamptz, p_days integer DEFAULT 30,
 p_population text DEFAULT 'customer_facing')
RETURNS TABLE (event_id uuid, placed_job_id uuid, stratum text, lane text, captured_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT x.id, x.job_id, x.stratum, x.lane, x.cap
 FROM (
  SELECT b.id, b.job_id, coalesce(b.context_captured_at, b.recorded_at) AS cap, b.metadata->'party_roles'->>'audience' AS aud,
         public.context_scorecard_lane_of(b.event_type, b.source, b.channel, b.direction, b.body_preview, b.metadata) AS lane,
         public.context_placement_stratum(b.attribution_status, b.metadata->>'placement_rule', b.match_method) AS stratum
  FROM public.business_events b
  WHERE b.job_id IS NOT NULL
    AND coalesce(b.context_captured_at, b.recorded_at) > p_as_of - make_interval(days => p_days)
    AND coalesce(b.context_captured_at, b.recorded_at) <= p_as_of
 ) x
 WHERE public.context_placement_in_population(p_population, x.lane, x.aud)
$fn$;
COMMENT ON FUNCTION public.context_placement_population(timestamptz, integer, text) IS
 'Context placement grades (20261007070000): read only. The PLACED items of a graded population (context_placement_in_population: customer_facing, the default, or xero_and_quotes), on a job, captured (context_captured_at, else recorded_at) in (p_as_of - p_days, p_as_of]; each with its job, placement stratum, lane and capture time. Ids only. Service role only.';

-- 5. The digest of a whole draw, as its rows are saved (a JSON array of sample rows).
-- Plain SQL: the sampler stamps it on every row and the load re-computes it from the saved draw.
CREATE OR REPLACE FUNCTION public.context_placement_draw_digest(p_draw jsonb)
RETURNS text
LANGUAGE sql STABLE
AS $fn$
 SELECT CASE WHEN count(*) = 0 OR count(DISTINCT x.h) <> 1 OR bool_or(x.h IS NULL OR x.r IS NULL OR x.pos IS NULL) THEN NULL
  ELSE md5('placement-draw-v1|' || min(x.h) || '|' || string_agg(x.r, ',' ORDER BY x.pos, x.r COLLATE "C")) END
 FROM (
  SELECT (d->>'sample_id') || '|' || (d->>'population') || '|'
          || to_char((d->>'as_of')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' || (d->>'drawn') || '|'
          || (d->>'population_rows') || '|' || (d->>'population_all') AS h,
         (d->>'pos')::integer AS pos,
         (d->>'pos') || ':' || (d->>'event_id') || ':' || (d->>'placed_job_id') || ':' || (d->>'stratum') || ':'
          || (d->>'stratum_rows') || ':' || (d->>'stratum_drawn') AS r
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_draw) = 'array' THEN p_draw ELSE '[]'::jsonb END) d
 ) x
$fn$;
COMMENT ON FUNCTION public.context_placement_draw_digest(jsonb) IS
 'Context placement grades (20261007070000): the md5 digest of a whole placement draw from its rows as saved (a JSON array of context_placement_sample rows): the sample id, population, draw instant (UTC), drawn, population_rows and population_all, then every row''s pos, event_id, placed_job_id, stratum, stratum_rows and stratum_drawn in draw order. Null when the array is empty, a field is missing, or the rows disagree about the draw. The sampler stamps it on every row; the load re-computes it, so a draw saved short, mixed with another or edited never loads. Service role only.';

-- 6. The sampler. Read only; ids, codes and counts only out.
CREATE OR REPLACE FUNCTION public.context_placement_sample(p_as_of timestamptz DEFAULT NULL, p_size integer DEFAULT 120,
 p_seed text DEFAULT NULL, p_days integer DEFAULT 30, p_population text DEFAULT 'customer_facing')
RETURNS TABLE (sample_id text, population text, as_of timestamptz, pos integer, event_id uuid, placed_job_id uuid, stratum text,
 stratum_rows integer, stratum_drawn integer, drawn integer, population_rows integer, population_all integer, draw_digest text,
 lane text, captured_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
 v_as_of timestamptz := date_trunc('second', coalesce(p_as_of, now()));
 v_id text;
 v_all integer;
BEGIN
 IF p_size IS NULL OR p_size < 1 OR p_size > 1000 THEN
  RAISE EXCEPTION 'context_placement_sample: p_size must be between 1 and 1000';
 END IF;
 IF p_days IS NULL OR p_days < 1 OR p_days > 366 THEN
  RAISE EXCEPTION 'context_placement_sample: p_days must be between 1 and 366';
 END IF;
 IF p_seed IS NOT NULL AND p_seed !~ '^[a-z0-9]{1,16}$' THEN
  RAISE EXCEPTION 'context_placement_sample: p_seed must be 1 to 16 lower-case letters or digits';
 END IF;
 IF p_population IS NULL OR p_population NOT IN ('customer_facing', 'xero_and_quotes') THEN
  RAISE EXCEPTION 'context_placement_sample: p_population must be customer_facing or xero_and_quotes';
 END IF;
 -- The id names everything the draw depends on, so one id always draws the same rows from the same data.
 v_id := 'placement-' || CASE p_population WHEN 'customer_facing' THEN 'cf' ELSE 'xq' END || '-'
         || to_char(v_as_of AT TIME ZONE 'UTC', 'YYYYMMDD"t"HH24MISS"z"') || '-n' || p_size || '-d' || p_days
         || coalesce('-' || p_seed, '');
 -- Every item of the population in the window, placed or not: the denominator of the placed share.
 SELECT count(*)::integer INTO v_all
 FROM public.business_events b
 WHERE coalesce(b.context_captured_at, b.recorded_at) > v_as_of - make_interval(days => p_days)
   AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of
   AND public.context_placement_in_population(p_population,
        public.context_scorecard_lane_of(b.event_type, b.source, b.channel, b.direction, b.body_preview, b.metadata),
        b.metadata->'party_roles'->>'audience');
 RETURN QUERY
 WITH pop AS MATERIALIZED (
  SELECT p.event_id AS eid, p.placed_job_id AS jid, p.stratum AS st, p.lane AS ln, p.captured_at AS cap,
         md5(v_id || ':' || p.event_id::text) AS dk
  FROM public.context_placement_population(v_as_of, p_days, p_population) p
 ), sizes AS (
  SELECT pop.st, count(*)::integer AS n FROM pop GROUP BY pop.st
 ), tot AS (
  SELECT coalesce(sum(sizes.n), 0)::integer AS total, count(*)::integer AS strata FROM sizes
 ), floor_ AS (
  -- Every stratum first gets up to 5 (fewer when the sample is too small for 5 each, or the stratum smaller).
  SELECT s.st, s.n, t.total,
         CASE WHEN t.total <= p_size THEN s.n ELSE least(s.n, least(5, p_size / t.strata)) END AS a1
  FROM sizes s CROSS JOIN tot t
 ), rest AS (
  SELECT f.st, f.n, f.total, f.a1, (p_size - sum(f.a1) OVER ())::integer AS r, (sum(f.n - f.a1) OVER ())::integer AS cap_total
  FROM floor_ f
 ), quota AS (
  -- The rest in proportion to what each stratum has left.
  SELECT q.st, q.n, q.a1, q.r,
         CASE WHEN q.total <= p_size OR q.cap_total = 0 OR q.r <= 0 THEN 0::numeric
              ELSE q.r::numeric * (q.n - q.a1) / q.cap_total END AS quota
  FROM rest q
 ), base AS (
  SELECT b.st, b.n, b.a1, b.r, floor(b.quota)::integer AS base, b.quota - floor(b.quota) AS frac FROM quota b
 ), extra AS (
  -- Largest remainder: what floor() left goes one each to the largest fractions, ties by stratum name.
  SELECT e.st, e.n, e.a1, e.base, e.frac, greatest(e.r - sum(e.base) OVER (), 0)::integer AS left_,
         row_number() OVER (ORDER BY e.frac DESC, e.st COLLATE "C") AS frank
  FROM base e
 ), alloc AS (
  SELECT x.st, x.n, (x.a1 + x.base + CASE WHEN x.frac > 0 AND x.frank <= x.left_ THEN 1 ELSE 0 END)::integer AS k FROM extra x
 ), ranked AS (
  SELECT pop.eid, pop.jid, pop.st, pop.ln, pop.cap, pop.dk,
         row_number() OVER (PARTITION BY pop.st ORDER BY pop.dk COLLATE "C", pop.eid) AS rk
  FROM pop
 ), drawn_ AS (
  SELECT (row_number() OVER (ORDER BY r.dk COLLATE "C", r.eid))::integer AS pos_, r.eid, r.jid, r.st, a.n AS st_rows, a.k AS st_drawn,
         r.ln, r.cap
  FROM ranked r JOIN alloc a ON a.st = r.st
  WHERE r.rk <= a.k
 ), facts AS (
  SELECT count(*)::integer AS drawn_n, (SELECT t.total FROM tot t) AS pop_rows FROM drawn_
 ), rows_ AS (
  SELECT v_id AS sid, p_population AS popn, v_as_of AS at_, d.pos_, d.eid, d.jid, d.st, d.st_rows, d.st_drawn,
         f.drawn_n, f.pop_rows, greatest(v_all, f.pop_rows) AS pop_all, d.ln, d.cap
  FROM drawn_ d CROSS JOIN facts f
 ), dig AS (
  SELECT public.context_placement_draw_digest(coalesce(jsonb_agg(jsonb_build_object('sample_id', x.sid, 'population', x.popn,
          'as_of', x.at_, 'pos', x.pos_, 'event_id', x.eid, 'placed_job_id', x.jid, 'stratum', x.st, 'stratum_rows', x.st_rows,
          'stratum_drawn', x.st_drawn, 'drawn', x.drawn_n, 'population_rows', x.pop_rows, 'population_all', x.pop_all)), '[]'::jsonb)) AS d
  FROM rows_ x
 )
 SELECT x.sid, x.popn, x.at_, x.pos_, x.eid, x.jid, x.st, x.st_rows, x.st_drawn, x.drawn_n, x.pop_rows, x.pop_all, dig.d, x.ln, x.cap
 FROM rows_ x CROSS JOIN dig
 ORDER BY x.pos_;
END $fn$;
COMMENT ON FUNCTION public.context_placement_sample(timestamptz, integer, text, integer, text) IS
 'Context placement grades (20261007070000): read only, ids, codes and counts only. Draws p_size (default 120, at most 1000) placed items of a population (p_population: customer_facing, the default, or xero_and_quotes) from context_placement_population(p_as_of truncated to the second, default now; p_days default 30), stratified by context_placement_stratum: each stratum up to 5 first (fewer when smaller, or when the sample cannot give 5 each), the rest in proportion to what each stratum has left (largest remainder, ties by stratum name); inside a stratum the order is md5(sample_id:event id). sample_id (placement-cf- or placement-xq-) names the population, instant, size, days and optional seed (1 to 16 lower-case letters or digits), so one sample_id draws the same rows from the same data. Returns sample_id, population, as_of, pos (1..drawn in draw order), event_id, placed_job_id, stratum, stratum_rows (its population), stratum_drawn, drawn (how many the draw holds), population_rows (placed items in the window), population_all (every item of the population in the window, placed or not), draw_digest (context_placement_draw_digest of the whole draw), lane, captured_at. Save the whole output as the draw: the load takes it and refuses anything less. Service role only.';

-- 7. The grader's card for one sampled item. Read only; it carries words, for the grader only.
CREATE OR REPLACE FUNCTION public.context_placement_grade_card(p_event_id uuid, p_placed_job_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
 e public.business_events; v_at timestamptz; v_contact text; v_basis text; v_job uuid; v_subject text; v_lane text;
 v_ek text; v_pk text; v_found text; v_n integer; v_x jsonb; v_q jsonb;
 v_placed jsonb; v_jobs jsonb := '[]'::jsonb; v_named jsonb := '[]'::jsonb; v_near jsonb := '[]'::jsonb; v_record jsonb;
BEGIN
 SELECT * INTO e FROM public.business_events b WHERE b.id = p_event_id;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('version', 'context-placement-grade-card-v2', 'event_id', p_event_id, 'found', false);
 END IF;
 v_at := coalesce(e.event_at, e.occurred_at);
 v_lane := public.context_scorecard_lane_of(e.event_type, e.source, e.channel, e.direction, e.body_preview, e.metadata);
 -- The customer: the row's contact, else the GHL contact its own payload carries (the old text-cache backfill),
 -- else the one contact its own email or phone key names (the ladder's identity step).
 v_contact := nullif(btrim(e.contact_id), '');
 v_basis := CASE WHEN v_contact IS NOT NULL THEN 'row' END;
 IF v_contact IS NULL AND nullif(btrim(e.payload->>'ghl_contact_id'), '') IS NOT NULL THEN
  v_contact := btrim(e.payload->>'ghl_contact_id'); v_basis := 'payload';
 END IF;
 IF v_contact IS NULL THEN
  SELECT i.email_key, i.phone_key INTO v_ek, v_pk FROM public.context_event_identity(e) i;
  IF v_ek IS NOT NULL OR v_pk IS NOT NULL THEN
   SELECT c.contact_id, c.contacts INTO v_found, v_n FROM public.context_contact_for_key(v_ek, v_pk) c;
   IF v_n = 1 THEN v_contact := v_found; v_basis := CASE WHEN v_ek IS NOT NULL THEN 'email_key' ELSE 'phone_key' END; END IF;
  END IF;
 END IF;
 v_job := coalesce(p_placed_job_id, e.job_id);
 v_subject := coalesce(nullif(btrim(e.payload->>'subject'), ''), substring(public.context_event_text(e) from '^Subject: ([^\r\n]*)'));
 SELECT jsonb_build_object('job_id', j.id, 'job_number', j.job_number, 'type', j.type, 'status_now', j.status,
         'created_at', j.created_at, 'completed_at', j.completed_at, 'created_after_message', j.created_at > v_at,
         'site_address', j.site_address, 'site_suburb', j.site_suburb, 'client_name', j.client_name,
         'holding_job', coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1'))
 INTO v_placed FROM public.jobs j WHERE j.id = v_job;
 IF v_contact IS NOT NULL THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('job_id', t.job_id, 'job_number', t.job_number, 'type', t.type,
          'status_now', t.status, 'basis', t.basis, 'created_at', t.created_at, 'created_after_message', t.created_at > v_at,
          'live_at_message', t.candidate, 'finished_before_message', coalesce(t.terminal AND t.terminal_at <= v_at, false),
          'site_address', jj.site_address, 'site_suburb', jj.site_suburb, 'client_name', jj.client_name)
          ORDER BY t.created_at, t.job_id), '[]'::jsonb)
  INTO v_jobs
  FROM public.context_contact_job_timeline(v_contact, v_at) t LEFT JOIN public.jobs jj ON jj.id = t.job_id;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('job_id', r.job_id, 'job_number', r.job_number, 'ref_kind', r.ref_kind,
         'status_now', r.status, 'created_after_message', r.created_at > v_at) ORDER BY r.job_number COLLATE "C", r.job_id), '[]'::jsonb)
 INTO v_named
 FROM (SELECT DISTINCT ON (x.job_id) x.job_id, x.ref_kind, jj.job_number, jj.status, jj.created_at
       FROM public.context_ref_jobs(public.context_job_ref_tokens(public.context_bucket_text(e))) x
       LEFT JOIN public.jobs jj ON jj.id = x.job_id
       ORDER BY x.job_id, x.ref_kind COLLATE "C") r;
 -- The record a Xero or quote item stands for, from the record's own fields (never the job a sync linked it to).
 IF v_lane = 'xero' AND nullif(btrim(e.payload->>'xero_invoice_id'), '') IS NOT NULL AND to_regclass('public.xero_invoices') IS NOT NULL THEN
  EXECUTE 'SELECT to_jsonb(x) FROM public.xero_invoices x WHERE x.xero_invoice_id = $1 LIMIT 1' INTO v_x USING btrim(e.payload->>'xero_invoice_id');
  v_record := jsonb_build_object('kind', 'invoice', 'invoice_number', coalesce(v_x->>'invoice_number', e.payload->>'invoice_number'),
   'reference', v_x->>'reference', 'contact_name', coalesce(v_x->>'contact_name', e.payload->>'contact_name'),
   'invoice_type', v_x->>'invoice_type', 'status', coalesce(v_x->>'status', e.payload->>'invoice_status'),
   'total', coalesce(v_x->'total', e.payload->'total'), 'invoice_date', coalesce(v_x->>'invoice_date', e.payload->>'invoice_date'),
   'lines', (SELECT coalesce(jsonb_agg(left(l.value->>'Description', 200) ORDER BY l.ordinality), '[]'::jsonb)
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_x->'line_items') = 'array' THEN v_x->'line_items' ELSE '[]'::jsonb END)
                  WITH ORDINALITY l WHERE l.ordinality <= 5));
 ELSIF v_lane = 'xero' THEN
  v_record := jsonb_build_object('kind', 'invoice', 'invoice_number', e.payload->>'invoice_number', 'contact_name', e.payload->>'contact_name',
   'total', e.payload->'total', 'invoice_date', e.payload->>'invoice_date');
 ELSIF v_lane = 'quotes' AND (e.payload->>'quote_revision_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND to_regclass('public.quote_revisions') IS NOT NULL THEN
  EXECUTE 'SELECT to_jsonb(q) FROM public.quote_revisions q WHERE q.id = $1' INTO v_q USING (e.payload->>'quote_revision_id')::uuid;
  v_record := jsonb_build_object('kind', 'quote', 'version', v_q->'version', 'recipient_label', v_q->>'recipient_label',
   'option_label', v_q->>'option_label', 'sent_at', v_q->>'sent_at',
   'built_on_job_number', (SELECT jj.job_number FROM public.jobs jj WHERE jj.id::text = v_q->>'job_id'));
 ELSIF v_lane = 'quotes' THEN
  v_record := jsonb_build_object('kind', 'quote', 'job_number_named', e.payload->>'job_number');
 END IF;
 IF v_contact IS NOT NULL OR nullif(e.thread_key, '') IS NOT NULL THEN
  WITH near AS (
   SELECT n AS row_, coalesce(n.event_at, n.occurred_at) AS at_
   FROM public.business_events n
   WHERE n.id <> e.id
     AND coalesce(n.event_at, n.occurred_at) BETWEEN v_at - interval '14 days' AND v_at + interval '14 days'
     AND ((v_contact IS NOT NULL AND (n.contact_id = v_contact OR n.payload @> jsonb_build_object('ghl_contact_id', v_contact)))
          OR (nullif(e.thread_key, '') IS NOT NULL AND n.thread_key = e.thread_key))
  ), pick AS (
   (SELECT near.row_, near.at_ FROM near WHERE near.at_ < v_at ORDER BY near.at_ DESC, (near.row_).id DESC LIMIT 3)
   UNION ALL
   (SELECT near.row_, near.at_ FROM near WHERE near.at_ >= v_at ORDER BY near.at_, (near.row_).id LIMIT 3)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('event_id', (p.row_).id, 'at', p.at_, 'direction', (p.row_).direction,
          'lane', public.context_scorecard_lane_of((p.row_).event_type, (p.row_).source, (p.row_).channel, (p.row_).direction,
                  (p.row_).body_preview, (p.row_).metadata),
          'job_id', (p.row_).job_id, 'job_number', (SELECT jj.job_number FROM public.jobs jj WHERE jj.id = (p.row_).job_id),
          'text', left(public.context_event_text(p.row_), 300))
          ORDER BY p.at_, (p.row_).id), '[]'::jsonb)
  INTO v_near FROM pick p;
 END IF;
 RETURN jsonb_build_object(
  'version', 'context-placement-grade-card-v2', 'found', true, 'event_id', e.id,
  'at', v_at, 'captured_at', coalesce(e.context_captured_at, e.recorded_at),
  'lane', v_lane, 'event_type', e.event_type, 'channel', e.channel, 'direction', e.direction, 'source', e.source,
  'sender_role', e.metadata->'party_roles'->>'sender_role', 'recipient_role', e.metadata->'party_roles'->>'recipient_role',
  'audience', e.metadata->'party_roles'->>'audience', 'contact_id', v_contact, 'contact_basis', v_basis,
  'sender', left(coalesce(nullif(btrim(e.payload->>'from'), ''), nullif(btrim(e.payload->>'email'), ''), nullif(btrim(e.payload->>'phone'), '')), 200),
  'subject', v_subject, 'text', left(public.context_event_text(e), 2000), 'record', v_record,
  'placed', v_placed, 'job_now', e.job_id, 'moved_since_draw', p_placed_job_id IS NOT NULL AND e.job_id IS DISTINCT FROM p_placed_job_id,
  'customer_jobs_at_message', v_jobs, 'named_jobs', v_named, 'nearby_messages', v_near);
END $fn$;
COMMENT ON FUNCTION public.context_placement_grade_card(uuid, uuid) IS
 'Context placement grades (20261007070000): read only. The evidence a placement grader reads for one item: when it was sent, its lane, direction and party roles, the customer (contact_id with contact_basis: the row''s contact, else the payload''s ghl_contact_id, else the one contact its own email or phone key names), its sender field, subject and text (first 2,000 characters), the record a Xero or quote item stands for (record: an invoice''s own number, reference, contact, type, status, total, date and first five line words; a quote''s version, recipient, option and the job it was built on), the job it was placed on (p_placed_job_id, the drawn job, when given; job_now and moved_since_draw say whether it has moved), the customer''s jobs as they stood at the message time (context_contact_job_timeline: live_at_message, finished_before_message, created_after_message), the jobs its words name (context_ref_jobs) and up to three messages before and after it within 14 days from the same customer or thread (first 300 characters). It never says how the ladder placed the item. Carries words: for the grader only, never for git or a report. Service role only.';

-- 8. The newest sample of a population, as the scorecard reads it. Always one row.
CREATE OR REPLACE FUNCTION public.context_placement_grades_newest(p_as_of timestamptz DEFAULT now(),
 p_population text DEFAULT 'customer_facing')
RETURNS TABLE (sample_id text, population text, as_of timestamptz, graded_at timestamptz, drawn integer, graded integer,
 missing integer, right_count integer, wrong_count integer, unsure_count integer, right_share numeric, weighted_right_share numeric,
 placed_share numeric, right_of_all numeric, strata jsonb, samples integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH stored AS (
  SELECT g.* FROM public.context_placement_grades g
  WHERE g.population = coalesce(p_population, 'customer_facing')
    AND g.created_at <= coalesce(p_as_of, now()) AND g.graded_at <= coalesce(p_as_of, now())
 ), newest AS (
  SELECT s.sample_id AS sid FROM stored s GROUP BY s.sample_id
  ORDER BY max(s.as_of) DESC, s.sample_id COLLATE "C" DESC LIMIT 1
 ), g AS (
  SELECT s.* FROM stored s JOIN newest n ON n.sid = s.sample_id
 ), per AS (
  -- A stratum's share is right over what the draw took from it: an item drawn and not graded is never right.
  SELECT g.stratum AS st, count(*)::integer AS graded, count(*) FILTER (WHERE g.verdict = 'right')::integer AS r,
         count(*) FILTER (WHERE g.verdict = 'wrong')::integer AS w, count(*) FILTER (WHERE g.verdict = 'unsure')::integer AS u,
         max(g.stratum_rows) AS rows_, max(g.stratum_drawn) AS drawn_
  FROM g GROUP BY g.stratum
 ), tot AS (
  SELECT max(g.as_of) AS as_of_, max(g.graded_at) AS graded_at_, count(*)::integer AS graded_, max(g.drawn) AS drawn_,
         max(g.population_rows) AS pop_rows, max(g.population_all) AS pop_all,
         count(*) FILTER (WHERE g.verdict = 'right')::integer AS r_, count(*) FILTER (WHERE g.verdict = 'wrong')::integer AS w_,
         count(*) FILTER (WHERE g.verdict = 'unsure')::integer AS u_
  FROM g
 ), raw AS (
  -- Unrounded shares. right_share is over the whole draw; a stratum's share is over what the draw took from it,
  -- weighted by its size at the draw (a stratum left out of the load entirely still lowers right_share).
  SELECT tot.*,
         CASE WHEN coalesce(tot.drawn_, 0) = 0 THEN NULL ELSE tot.r_::numeric / tot.drawn_ END AS rs,
         (SELECT sum(per.rows_::numeric * per.r / greatest(per.drawn_, per.graded)) / nullif(sum(per.rows_), 0) FROM per) AS ws,
         CASE WHEN coalesce(tot.pop_all, 0) = 0 THEN NULL ELSE tot.pop_rows::numeric / tot.pop_all END AS ps
  FROM tot
 ), st AS (
  SELECT jsonb_object_agg(per.st, jsonb_build_object('drawn', per.drawn_, 'graded', per.graded, 'right', per.r, 'wrong', per.w,
          'unsure', per.u, 'stratum_rows', per.rows_)) AS strata_
  FROM per
 )
 SELECT (SELECT n.sid FROM newest n), coalesce(p_population, 'customer_facing'), raw.as_of_, raw.graded_at_, raw.drawn_, raw.graded_,
        CASE WHEN raw.drawn_ IS NULL THEN NULL ELSE greatest(raw.drawn_ - raw.graded_, 0) END, raw.r_, raw.w_, raw.u_,
        CASE WHEN raw.rs IS NULL THEN NULL ELSE round(floor(round(raw.rs, 10) * 10000) / 10000, 4) END,
        CASE WHEN raw.ws IS NULL THEN NULL ELSE round(floor(round(raw.ws, 10) * 10000) / 10000, 4) END,
        CASE WHEN raw.ps IS NULL THEN NULL ELSE round(floor(round(raw.ps, 10) * 10000) / 10000, 4) END,
        CASE WHEN raw.rs IS NULL OR raw.ws IS NULL OR raw.ps IS NULL THEN NULL
             ELSE round(floor(round(least(raw.rs, raw.ws) * raw.ps, 10) * 10000) / 10000, 4) END,
        coalesce(st.strata_, '{}'::jsonb),
        (SELECT count(DISTINCT s.sample_id)::integer FROM stored s)
 FROM raw CROSS JOIN st
$fn$;
COMMENT ON FUNCTION public.context_placement_grades_newest(timestamptz, text) IS
 'Context placement grades (20261007070000): read only, always one row. The newest placement sample of a population (p_population: customer_facing, the default, or xero_and_quotes; latest as_of, then sample_id) among grades stored and graded by p_as_of (default now): sample_id, population, as_of (the draw instant), graded_at (its newest grade), drawn (how many items the draw holds), graded (right + wrong + unsure), missing (drawn and not graded), right_count, wrong_count, unsure_count, right_share (right / drawn: a missing item is never right), weighted_right_share (each stratum''s right / its drawn, weighted by its stratum_rows, its size at the draw), placed_share (population_rows / population_all at the draw: the scorecard lane''s placed share in the sample''s window), right_of_all (least(right_share, weighted_right_share) x placed_share: the estimated share of ALL the population''s items in the window on the right job, row 3''s own wording), every share rounded down to 4 decimals and null when nothing is stored; strata ({stratum: {drawn, graded, right, wrong, unsure, stratum_rows}}) and samples (samples of the population stored by p_as_of). An unsure verdict is never right. No threshold lives here: the bar (graded = drawn, drawn at least 100, right_of_all at least 0.95, for each population) is the scorecard policy''s. Service role only.';

-- 9. The twin: the row another writer already saved for the same GHL message.
CREATE OR REPLACE FUNCTION public.context_placement_message_twin(e public.business_events)
RETURNS TABLE (twin_id uuid, twin_job_id uuid, twin_status text, twin_state text, twin_keyed boolean, twin_source text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH g AS (
  SELECT coalesce(substring(e.provider_message_id FROM '^ghl:(.+)$'), nullif(btrim(e.payload->>'ghl_message_id'), ''),
                  nullif(btrim(e.payload->>'message_id'), '')) AS gid,
         btrim(public.context_event_text(e)) AS words
 ), o AS (
  SELECT DISTINCT b.id, b.job_id, b.attribution_status, b.source, b.provider_message_id, coalesce(b.event_at, b.occurred_at) AS at_,
         CASE WHEN public.context_event_source_admissible(b) AND b.context_captured_at IS NOT NULL THEN 'placed'
              WHEN b.job_id IS NULL AND b.attribution_status IN ('admin_bucket', 'unplaced', 'pending_luna') THEN 'queued' END AS state
  FROM g JOIN public.business_events b
    ON b.provider_message_id = 'ghl:' || g.gid
    OR b.payload @> jsonb_build_object('ghl_message_id', g.gid)
    OR b.payload @> jsonb_build_object('message_id', g.gid)
  WHERE g.gid IS NOT NULL AND b.id <> e.id
    AND b.event_type IS NOT DISTINCT FROM e.event_type
    AND btrim(public.context_event_text(b)) = g.words
    AND NOT (coalesce(b.metadata, '{}'::jsonb) ? 'duplicate_of')
    AND coalesce(b.metadata->>'written_as', 'service_role') = 'service_role'
    AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = b.job_id AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1'))
 )
 SELECT o.id, o.job_id, o.attribution_status, o.state, coalesce(o.provider_message_id LIKE 'ghl:%', false), o.source
 FROM o WHERE o.state IS NOT NULL
 ORDER BY (o.state = 'placed') DESC, coalesce(o.provider_message_id LIKE 'ghl:%', false) DESC, o.at_, o.id
 LIMIT 1
$fn$;
COMMENT ON FUNCTION public.context_placement_message_twin(public.business_events) IS
 'Context placement grades (20261007070000): read only. The row another writer already saved for the same GHL message as e (e''s GHL id: its ghl:<id> key, else payload.ghl_message_id or payload.message_id; the twin carries it the same ways), with the same event type and the same words, not itself marked a copy (metadata.duplicate_of), written as the service role and not on a holding job, that stands in for e: twin_state placed (admissible to every reader, context_event_source_admissible, and captured) or queued (no job; admin_bucket, unplaced or pending_luna). At most one: placed first, then a ghl: keyed row, then the oldest, then id. None means e is the only saved copy that can carry the message. The capture copies convention (20261006031000) marks e metadata.duplicate_of = twin_id. Service role only.';

-- 10. The plan for the known misfiles: the ladder's own judgement, in preview, and the copies already saved.
CREATE OR REPLACE FUNCTION public.context_placement_misfile_plan()
RETURNS TABLE (event_id uuid, from_job_id uuid, payload_job_id uuid, mismatch_class text, on_holding_job boolean, plan text,
 to_job_id uuid, candidate_job_ids uuid[], contact_id text, duplicate_of uuid, set_aside_payload_job boolean, decided jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE m record; e public.business_events; s public.business_events; r public.business_events; v_ids uuid[];
 v_twin uuid; v_twin_job uuid; v_twin_status text; v_twin_state text; v_twin_keyed boolean; v_twin_source text;
BEGIN
 FOR m IN SELECT x.id AS mid, x.from_job_id AS mfrom, x.to_job_id AS mto, x.class AS mclass
          FROM public.context_payload_job_mismatch_rows() x ORDER BY x.id LOOP
  SELECT * INTO e FROM public.business_events b WHERE b.id = m.mid;
  event_id := m.mid; from_job_id := m.mfrom; payload_job_id := m.mto; mismatch_class := m.mclass;
  contact_id := coalesce(nullif(btrim(e.contact_id), ''), nullif(btrim(e.payload->>'ghl_contact_id'), ''));
  on_holding_job := EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = m.mfrom AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1'));
  to_job_id := NULL; candidate_job_ids := NULL; decided := NULL; duplicate_of := NULL; set_aside_payload_job := false;
  IF NOT on_holding_job THEN
   plan := 'leave_not_on_holding_job';
   RETURN NEXT; CONTINUE;
  END IF;
  -- The row as the ladder would read it once repaired: its own customer, no job (a placeholder is never
  -- custody), capture_mode relink (rows re-linked by hand never go to the model), and the payload's job set
  -- aside (the writer's guess or inference: it may agree with the ladder, never decide for it).
  s := e;
  s.contact_id := contact_id; s.job_id := NULL; s.match_method := 'none'; s.match_status := 'unresolved';
  s.match_confidence := NULL; s.candidate_job_ids := NULL; s.attribution_status := NULL; s.attribution_step := NULL;
  s.attribution_confidence := NULL; s.attributed_at := NULL;
  s.metadata := (coalesce(e.metadata, '{}'::jsonb) - 'source_job_binding') || jsonb_build_object('capture_mode', 'relink');
  s.payload := coalesce(e.payload, '{}'::jsonb) - 'job_id';
  r := public.resolve_context_attribution(s, true, true);
  -- The copy check reads the row as it was saved: its own GHL id, event type and words.
  SELECT w.twin_id, w.twin_job_id, w.twin_status, w.twin_state, w.twin_keyed, w.twin_source
  INTO v_twin, v_twin_job, v_twin_status, v_twin_state, v_twin_keyed, v_twin_source
  FROM public.context_placement_message_twin(e) w;
  decided := jsonb_build_object('attribution_status', r.attribution_status, 'attribution_step', r.attribution_step,
   'attribution_confidence', r.attribution_confidence, 'match_status', r.match_status, 'match_method', r.match_method,
   'match_confidence', r.match_confidence, 'job_id', r.job_id, 'candidate_job_ids', to_jsonb(r.candidate_job_ids),
   'placement_rule', r.metadata->>'placement_rule', 'bucket_reason', r.metadata->>'bucket_reason',
   'ladder_keys', (SELECT coalesce(jsonb_object_agg(k.key, k.value), '{}'::jsonb) FROM jsonb_each(r.metadata) k
     WHERE k.key IN ('placement_guard_job_ids', 'placement_contactless_job_ids', 'placement_other_contact_job_ids',
      'aftercare_unpaid_job_ids', 'contact_recovered_by', 'identity_conflict', 'writer_unknown', 'ref_not_found')),
   'payload_job_guess', public.context_payload_job_is_guess(e),
   'twin', CASE WHEN v_twin IS NULL THEN NULL ELSE jsonb_build_object('id', v_twin, 'job_id', v_twin_job,
     'attribution_status', v_twin_status, 'state', v_twin_state, 'keyed', v_twin_keyed, 'source', v_twin_source) END,
   'error', r.payload->>'attribution_error');
  IF r.payload ? 'attribution_error' THEN
   plan := 'leave_error';
  ELSIF v_twin IS NOT NULL THEN
   -- The message is already saved by a row that stands in for this one: this row is its copy. It goes
   -- where its twin is (the twin's job, or no job while the twin waits in the queue), marked, never read.
   -- A copy never keeps the backfill's guessed payload job: wherever a later reopen puts it, it is no misfile.
   plan := 'duplicate'; duplicate_of := v_twin; set_aside_payload_job := true;
   to_job_id := CASE WHEN v_twin_state = 'placed' THEN v_twin_job END;
  ELSIF r.job_id IS NOT NULL AND r.job_id = m.mto AND public.context_linked_status(r.attribution_status) THEN
   plan := 'move'; to_job_id := r.job_id;
  ELSE
   plan := 'review'; set_aside_payload_job := true;
   v_ids := coalesce(r.candidate_job_ids, '{}'::uuid[]) || CASE WHEN r.job_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[r.job_id] END
            || CASE WHEN m.mto IS NULL THEN '{}'::uuid[] ELSE ARRAY[m.mto] END;
   SELECT array_agg(DISTINCT x ORDER BY x) INTO candidate_job_ids
   FROM unnest(v_ids) x
   WHERE NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = x AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1'));
  END IF;
  RETURN NEXT;
 END LOOP;
END $fn$;
COMMENT ON FUNCTION public.context_placement_misfile_plan() IS
 'Context placement grades (20261007070000): read only (the ladder runs in preview). Every row of context_payload_job_mismatch_rows() with a plan. A row on a holding job (metadata.do_not_schedule) is re-decided by resolve_context_attribution(row, preview true, rules on) as it would read once repaired: contact_id from the row or its payload''s ghl_contact_id, no job, capture_mode relink, the payload''s job_id set aside. duplicate: its GHL message is already saved by a twin that stands in (context_placement_message_twin): duplicate_of names the twin, to_job_id is the twin''s job when it is placed and null while it waits in the queue (the copy then takes no queue status); move: the ladder places it, by a linked status, on the job the payload names (to_job_id); review: anything else (candidate_job_ids: the ladder''s candidates, the job it chose and the payload''s job, holding jobs left out); leave_not_on_holding_job and leave_error are never touched. set_aside_payload_job: true for every review row and every copy: the repair sets that guessed payload job aside, so any candidate a reviewer picks is read and is no misfile, and a copy is never one wherever a reopen puts it. decided carries the ladder''s answer and the twin (ids and codes). One ladder decision per row: for scripts, not for an hourly read. Applied by scripts/context-placement-misfile-repair.sql with the owner''s go. Service role only.';

-- 11. Counts for the scorecard's known misfiles. Cheap; read only.
CREATE OR REPLACE FUNCTION public.context_placement_misfile_counts(p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH holding AS (
  SELECT j.id FROM public.jobs j WHERE coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1')
 ), mm AS (
  SELECT m.class, m.from_job_id IN (SELECT h.id FROM holding h) AS on_holding FROM public.context_payload_job_mismatch_rows() m
 ), onh AS (
  SELECT coalesce(b.context_captured_at, b.recorded_at) AS cap, b.metadata->'party_roles'->>'audience' AS aud,
         public.context_scorecard_lane_of(b.event_type, b.source, b.channel, b.direction, b.body_preview, b.metadata) AS lane
  FROM public.business_events b
  WHERE b.job_id IN (SELECT h.id FROM holding h) AND coalesce(b.context_captured_at, b.recorded_at) <= coalesce(p_as_of, now())
 )
 SELECT jsonb_build_object(
  'version', 'context-placement-misfile-counts-v1', 'as_of', coalesce(p_as_of, now()),
  'payload_mismatch', (SELECT count(*) FROM mm),
  'payload_mismatch_on_holding_job', (SELECT count(*) FROM mm WHERE mm.on_holding),
  'payload_mismatch_by_class', (SELECT coalesce(jsonb_object_agg(c.class, c.n), '{}'::jsonb)
                                FROM (SELECT mm.class, count(*) AS n FROM mm GROUP BY mm.class) c),
  'holding_jobs', (SELECT count(*) FROM holding),
  'on_holding_job', (SELECT count(*) FROM onh),
  'on_holding_job_customer_facing_30d', (SELECT count(*) FROM onh
    WHERE onh.cap > coalesce(p_as_of, now()) - interval '30 days'
      AND public.context_placement_in_population('customer_facing', onh.lane, onh.aud)),
  'live_bindings_to_holding_job', (SELECT count(*) FROM public.event_threads t
    WHERE t.retired_at IS NULL AND t.job_id IN (SELECT h.id FROM holding h)))
$fn$;
COMMENT ON FUNCTION public.context_placement_misfile_counts(timestamptz) IS
 'Context placement grades (20261007070000): read only. {payload_mismatch (context_payload_job_mismatch_rows, as now), payload_mismatch_on_holding_job, payload_mismatch_by_class, holding_jobs (metadata.do_not_schedule), on_holding_job (rows on a holding job captured by p_as_of), on_holding_job_customer_facing_30d (of those, customer-facing rows captured in the 30 days before p_as_of), live_bindings_to_holding_job (event_threads, retired_at null)}. A holding job is never a customer''s job, so every row on one is a known misfile. Service role only.';

-- 12. Access: service role only. The stratum, population and digest helpers are pure functions of their arguments.
REVOKE ALL ON FUNCTION public.context_placement_stratum(text, text, text),
 public.context_placement_in_population(text, text, text),
 public.context_placement_population(timestamptz, integer, text),
 public.context_placement_draw_digest(jsonb),
 public.context_placement_sample(timestamptz, integer, text, integer, text),
 public.context_placement_grade_card(uuid, uuid),
 public.context_placement_grades_newest(timestamptz, text),
 public.context_placement_message_twin(public.business_events),
 public.context_placement_misfile_plan(),
 public.context_placement_misfile_counts(timestamptz)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_placement_stratum(text, text, text),
 public.context_placement_in_population(text, text, text),
 public.context_placement_population(timestamptz, integer, text),
 public.context_placement_draw_digest(jsonb),
 public.context_placement_sample(timestamptz, integer, text, integer, text),
 public.context_placement_grade_card(uuid, uuid),
 public.context_placement_grades_newest(timestamptz, text),
 public.context_placement_message_twin(public.business_events),
 public.context_placement_misfile_plan(),
 public.context_placement_misfile_counts(timestamptz)
TO service_role;
