-- Context grades: where graded samples are kept, the read that says how the
-- newest sample of each kind did, and the published catalogue of ledger item
-- kinds (done definition rows 7, 8 and 9; owner ruling 7 Oct 2026).
--
-- Why. The owner's definition of done (5 Oct 2026) makes three rows depend on
-- an independent grade: row 7 (a published catalogue of fact kinds, and a
-- grader passes at least 95% of facts on a 10-job sample against the records),
-- row 8 (the job answer is correct on a 10-job graded sample) and row 9 (the
-- agent answers where a job is at, what we last told the customer and what is
-- owed for a 10-job test set; 9+ adds the story and what is outstanding). On 7
-- Oct 2026 the owner ruled that everything runs on the new AI reader: row 7's
-- facts are the job ledger's items, row 8's answer is the job story card and
-- row 9 is the agent test. The scorecard (20261006032000) keeps those lanes red
-- because no catalogue is published and no grade is stored in the database.
-- This migration publishes the catalogue and stores the grades. It does not
-- touch the scorecard: the scorecard's own builder reads what is here.
--
-- What it adds:
--  1. context_item_kinds(): the published catalogue of ledger item
--     kinds. One row per kind: its meaning in plain words, the statuses a
--     reader may write it with, the fields it needs beyond the shared ones,
--     and accepted: whether the store's own check on
--     context_ledger_items.item_type (20261006010000, which the store's item
--     check, 20261006013000, enforces again) accepts it, read live. A kind the
--     store accepts with no published meaning is listed with meaning null, and
--     a published kind the store no longer accepts is listed with accepted
--     false, so the catalogue never silently drifts from the store. It is
--     named outside context_ledger_*: that prefix is the store's own, and the
--     store's contract holds every function of it to the store's rules.
--  2. context_grades: one row per graded unit of one sample. kind ledger: one
--     ledger item (T5 verbatim, right parties, supported; T8). kind story: one
--     job's story card (T1 to T4, T6, T8, money, dates, honesty, orientation).
--     kind agent: one T7 agent call (where_at, last_told, owed, story, period;
--     T8). The verdicts are codes, counts and row ids only, never words: the
--     table's check refuses any other key or value. Service role reads and
--     inserts; nobody else may do anything; RLS on with no policy.
--  3. context_grade_verdicts_problem(kind, unit, verdicts): the shape check
--     the table enforces (null when the verdicts are well formed, else what is
--     wrong). context_grade_passed(kind, unit, verdicts): the one rule for
--     whether a graded unit passes.
--  4. context_grade_samples(as_of): every sample loaded by as_of, with its
--     pass share, size and per-test counts, the newest of each kind marked.
--     context_grades_newest(as_of): the newest sample of each kind, always
--     three rows (ledger, story, agent), zeros and nulls when a kind has none.
--     This is the read the scorecard's rows 7, 8 and 9 take.
--
-- No threshold lives here: the bars (95% of items, 10 jobs, 30 of 30 calls)
-- belong to context_scorecard_policy() and its builder. A pass share is never
-- rounded up. Nothing is written by this migration: no grade, flag, cron job,
-- trigger or business row, and no existing function is replaced. A finished
-- grade is loaded by scripts/context-grades-load.sql (guarded, ends in
-- ROLLBACK until the owner's go; scripts/context-grades-load-undo.sql removes
-- one sample).
--
-- Rollback: supabase/rollbacks/20261007090000_context_grades_down.sql. It
-- refuses while any graded row is stored, so a grade is never dropped by
-- accident.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; x record; cols text; types text;
BEGIN
 IF to_regclass('public.jobs') IS NULL THEN problems := problems || 'public.jobs is missing'::text; END IF;
 -- The catalogue describes exactly the kinds the store accepts today.
 IF to_regclass('public.context_ledger_items') IS NULL THEN
  problems := problems || 'public.context_ledger_items is missing (apply 20261006010000 first)'::text;
 ELSE
  -- The catalogue's own rule (section 1): a kind every check on the column accepts, read from IN lists only.
  WITH checks AS (
   SELECT c.oid, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
   WHERE c.conrelid = 'public.context_ledger_items'::regclass AND c.contype = 'c'
     AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                           WHERE a.attrelid = 'public.context_ledger_items'::regclass AND a.attname = 'item_type' AND NOT a.attisdropped)]
  ), store AS (
   SELECT r[1] AS t
   FROM checks k CROSS JOIN LATERAL regexp_matches(k.def, '''([a-z_]+)''::text', 'g') AS r
   WHERE k.def ~ '^CHECK \(\(item_type = ANY \(ARRAY\[[^]]*\]\)\)\)( NOT VALID)?$'
   GROUP BY r[1]
   HAVING count(DISTINCT k.oid) = (SELECT count(*) FROM checks)
  )
  SELECT string_agg(store.t, ',' ORDER BY store.t COLLATE "C") INTO types FROM store;
  IF types IS DISTINCT FROM 'agreement,claim,commitment,constraint,dependency,event,issue,phase_note,request' THEN
   problems := problems || format('the store accepts the item types %s; this catalogue describes agreement, claim, commitment, '
    'constraint, dependency, event, issue, phase_note and request', coalesce(types, '<none>'));
  END IF;
 END IF;
 IF to_regclass('public.context_ledger_generations') IS NULL THEN
  problems := problems || 'public.context_ledger_generations is missing (apply 20261006010000 first)'::text;
 END IF;
 IF to_regprocedure('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)') IS NULL THEN
  problems := problems || 'public.context_ledger_check_item(uuid,jsonb,text,uuid,text) is missing (apply 20261006013000 first)'::text;
 END IF;
 -- The table: absent, or exactly this migration's (a re-apply).
 IF to_regclass('public.context_grades') IS NOT NULL THEN
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid = 'public.context_grades'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF coalesce(obj_description('public.context_grades'::regclass, 'pg_class'), '') NOT LIKE 'Context grades (20261007090000)%'
   OR cols IS DISTINCT FROM 'id:uuid,kind:text,sample_id:text,job_id:uuid,unit:text,generation_id:uuid,reading_model:text,'
     'item_type:text,stratum:text,gated:boolean,verdicts:jsonb,grader:text,as_of:timestamp with time zone,'
     'graded_at:timestamp with time zone,created_at:timestamp with time zone' THEN
   problems := problems || format('public.context_grades exists and is not this migration''s (columns %s)', cols);
  END IF;
 END IF;
 -- The functions: every overload of these names is absent or this migration's.
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('context_item_kinds', 'context_grade_verdicts_problem',
   'context_grade_passed', 'context_grade_samples', 'context_grades_newest') LOOP
  IF x.c NOT LIKE 'Context grades (20261007090000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_grades_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The published catalogue of ledger item kinds. The meanings are the store's
-- (20261006013000: context_ledger_check_item and its contract section 7.2);
-- accepted is read live from the store's check on context_ledger_items.item_type
-- (the IN list; with more than one check on the column, a kind every one of
-- them accepts). statuses: what a reader may write the kind with (any item may
-- later be disputed, and a person may close or reopen it); an open item closes
-- only when a later record or message shows it, never because time passed.
CREATE OR REPLACE FUNCTION public.context_item_kinds()
RETURNS TABLE (item_type text, ord integer, meaning text, statuses text[], needs text[], accepted boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $fn$
 WITH published (item_type, ord, meaning, statuses, needs) AS (VALUES
  ('commitment', 1, 'A promise: someone said they would do something (we told the customer, or the customer, a supplier or '
   'another party said they would). Open until a later record or message shows it done, declined or replaced.',
   ARRAY['open', 'closed', 'declined', 'superseded'], ARRAY[]::text[]),
  ('request', 2, 'Someone asked for something: an answer, information or an action. Open until it is answered or done.',
   ARRAY['open', 'closed', 'declined', 'superseded'], ARRAY[]::text[]),
  ('claim', 3, 'Someone stated something as a fact, often one the records do not show or contradict (for example that an '
   'invoice was paid). Open until a record or message settles it.',
   ARRAY['open', 'closed', 'declined', 'superseded'], ARRAY[]::text[]),
  ('issue', 4, 'A problem, complaint or defect someone raised. Open until it is fixed or resolved.',
   ARRAY['open', 'closed', 'declined', 'superseded'], ARRAY[]::text[]),
  ('constraint', 5, 'A limit the job has to work within: dates, access, availability or a preference. Open while it applies.',
   ARRAY['open', 'closed', 'declined', 'superseded'], ARRAY[]::text[]),
  ('dependency', 6, 'The job is waiting on someone or something outside it: a neighbour, supplier, council, engineer, insurer '
   'or builder. Open until that arrives.',
   ARRAY['open', 'closed', 'declined', 'superseded'], ARRAY[]::text[]),
  ('agreement', 7, 'Something agreed beyond the quote, with how far it got (requested, offered, agreed, declined, reported or '
   'confirmed) and what it replaces. Info while it is in force; open while it is still asked or offered.',
   ARRAY['open', 'closed', 'declined', 'superseded', 'info'], ARRAY['modality']),
  ('event', 8, 'Something that happened, told in the words, that no record shows (for example delivered, measured, approved or '
   'inspected). Information only.',
   ARRAY['info'], ARRAY[]::text[]),
  ('phase_note', 9, 'A short note on how one phase of the job went (one to three per phase). Information only.',
   ARRAY['info'], ARRAY['phase'])
 ), checks AS (
  SELECT c.oid, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public.context_ledger_items') AND c.contype = 'c'
    AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                          WHERE a.attrelid = to_regclass('public.context_ledger_items') AND a.attname = 'item_type' AND NOT a.attisdropped)]
 ), store AS (
  -- Literals are read only from an IN list (item_type = ANY (ARRAY[...])); a kind counts when every check on
  -- the column accepts it, so any other kind of check there leaves nothing accepted (fails closed).
  SELECT r[1] AS item_type
  FROM checks k CROSS JOIN LATERAL regexp_matches(k.def, '''([a-z_]+)''::text', 'g') AS r
  WHERE k.def ~ '^CHECK \(\(item_type = ANY \(ARRAY\[[^]]*\]\)\)\)( NOT VALID)?$'
  GROUP BY r[1]
  HAVING count(DISTINCT k.oid) = (SELECT count(*) FROM checks)
 )
 SELECT coalesce(p.item_type, s.item_type), coalesce(p.ord, 100), p.meaning, p.statuses, p.needs, s.item_type IS NOT NULL
 FROM published p FULL JOIN store s ON s.item_type = p.item_type
 ORDER BY coalesce(p.ord, 100), coalesce(p.item_type, s.item_type) COLLATE "C"
$fn$;
COMMENT ON FUNCTION public.context_item_kinds() IS
 'Context grades (20261007090000): the published catalogue of ledger item kinds (done definition row 7, owner ruling 7 Oct 2026: the facts are the job ledger''s items). One row per kind: item_type, ord, meaning (plain words; null for a kind the store accepts that has no published meaning), statuses (what a reader may write the kind with: open, closed, declined, superseded, and info for an agreement in force, an event or a phase note; any item may later be disputed, and a person may close or reopen it), needs (fields the kind needs beyond the shared ones: an agreement its modality, a phase note its phase) and accepted (the store''s check on context_ledger_items.item_type accepts it, read live; false for a published kind the store no longer accepts). Complete when every row has a meaning and is accepted. Service role only.';

-- 2. The shape of one unit's verdicts. Null when well formed, else what is
-- wrong. Codes, counts and row ids only: no key or value can carry words.
CREATE OR REPLACE FUNCTION public.context_grade_verdicts_problem(p_kind text, p_unit text, p_verdicts jsonb)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
 v jsonb := p_verdicts; allowed text[]; required text[]; k text; x jsonb; lo text; hi text;
 passfail constant text[] := ARRAY['verbatim', 'parties', 'supported', 'timeline', 'record_loops', 'first_line', 'money', 'dates', 'honesty'];
 row_tables constant text[] := ARRAY['business_events', 'inbox_events', 'email_events', 'job_events', 'job_documents',
  'job_assignments', 'xero_invoices', 'jobs', 'context_ledger_items', 'context_ledger_generations'];
BEGIN
 -- Every check below runs only after the checks it depends on (a type before its contents), one IF at a
 -- time: SQL does not promise to evaluate the arms of an OR in order.
 IF v IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'object' THEN RETURN 'verdicts must be an object'; END IF;
 IF octet_length(v::text) > 4096 THEN RETURN 'verdicts are over 4096 bytes'; END IF;
 IF p_kind = 'ledger' THEN
  allowed := ARRAY['verbatim', 'parties', 'supported', 'unsafe', 'unsafe_classes', 'rows'];
  required := ARRAY['verbatim', 'parties', 'supported', 'unsafe'];
 ELSIF p_kind = 'story' THEN
  allowed := ARRAY['timeline', 'record_loops', 'recall', 'precision', 'first_line', 'first_line_set', 'unsafe', 'unsafe_classes',
   'money', 'dates', 'honesty', 'orientation', 'rows'];
  required := ARRAY['first_line', 'unsafe'];
 ELSIF p_kind = 'agent' AND p_unit = 'story' THEN
  allowed := ARRAY['loops', 'unsafe', 'unsafe_classes', 'action_cards', 'story_tool', 'rows'];
  required := ARRAY['loops', 'unsafe'];
 ELSIF p_kind = 'agent' AND p_unit IN ('where_at', 'last_told', 'owed', 'period') THEN
  allowed := ARRAY['answer', 'unsafe', 'unsafe_classes', 'action_cards', 'story_tool', 'rows'];
  required := ARRAY['answer', 'unsafe'];
 ELSE
  RETURN 'no verdicts are defined for kind ' || coalesce(left(p_kind, 20), 'null') || ' unit ' || coalesce(left(p_unit, 40), 'null');
 END IF;
 SELECT min(t.key COLLATE "C") INTO k FROM jsonb_object_keys(v) AS t(key) WHERE NOT t.key = ANY (allowed);
 IF k IS NOT NULL THEN RETURN 'unknown verdict ' || left(k, 40); END IF;
 SELECT min(t.r COLLATE "C") INTO k FROM unnest(required) AS t(r) WHERE NOT v ? t.r;
 IF k IS NOT NULL THEN RETURN 'missing verdict ' || k; END IF;
 FOREACH k IN ARRAY passfail LOOP
  IF v ? k AND NOT (jsonb_typeof(v -> k) = 'string' AND v ->> k IN ('pass', 'fail')) THEN RETURN k || ' must be pass or fail'; END IF;
 END LOOP;
 IF v ? 'answer' AND NOT (jsonb_typeof(v -> 'answer') = 'string' AND v ->> 'answer' IN ('correct', 'wrong')) THEN
  RETURN 'answer must be correct or wrong';
 END IF;
 IF v ? 'first_line_set' AND NOT (jsonb_typeof(v -> 'first_line_set') = 'string' AND v ->> 'first_line_set' IN ('known', 'unseen')) THEN
  RETURN 'first_line_set must be known or unseen';
 END IF;
 IF v ? 'story_tool' AND jsonb_typeof(v -> 'story_tool') IS DISTINCT FROM 'boolean' THEN RETURN 'story_tool must be true or false'; END IF;
 -- Whole numbers from 0. The text test runs only on a number (a jsonb number prints without quotes).
 FOREACH k IN ARRAY ARRAY['unsafe', 'action_cards'] LOOP
  IF v ? k THEN
   IF jsonb_typeof(v -> k) IS DISTINCT FROM 'number' THEN RETURN k || ' must be a whole number from 0'; END IF;
   IF (v -> k)::text !~ '^[0-9]{1,6}$' THEN RETURN k || ' must be a whole number from 0'; END IF;
  END IF;
 END LOOP;
 IF p_kind = 'ledger' AND (v ->> 'unsafe')::integer > 1 THEN RETURN 'unsafe is 0 or 1 for one ledger item'; END IF;
 IF v ? 'orientation' THEN
  IF jsonb_typeof(v -> 'orientation') IS DISTINCT FROM 'number' THEN RETURN 'orientation must be a whole number from 1 to 5'; END IF;
  IF (v -> 'orientation')::text !~ '^[1-5]$' THEN RETURN 'orientation must be a whole number from 1 to 5'; END IF;
 END IF;
 IF v ? 'unsafe_classes' THEN
  x := v -> 'unsafe_classes';
  IF jsonb_typeof(x) IS DISTINCT FROM 'array' THEN RETURN 'unsafe_classes must be distinct T8 classes from 1 to 4'; END IF;
  IF jsonb_array_length(x) NOT BETWEEN 1 AND 4
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(x) AS e(c) WHERE NOT (jsonb_typeof(e.c) = 'number' AND e.c::text ~ '^[1-4]$'))
   OR (SELECT count(DISTINCT e.c) FROM jsonb_array_elements(x) AS e(c)) <> jsonb_array_length(x) THEN
   RETURN 'unsafe_classes must be distinct T8 classes from 1 to 4';
  END IF;
  IF (v ->> 'unsafe')::integer = 0 THEN RETURN 'unsafe_classes are given with unsafe 0'; END IF;
 END IF;
 IF v ? 'recall' THEN
  x := v -> 'recall';
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' THEN RETURN 'recall must be an object of money, record and message'; END IF;
  IF x = '{}'::jsonb OR EXISTS (SELECT 1 FROM jsonb_object_keys(x) AS t(key) WHERE t.key NOT IN ('money', 'record', 'message')) THEN
   RETURN 'recall must be an object of money, record and message';
  END IF;
 END IF;
 -- Count pairs: found of total (each recall class), real of shown (precision), covered of applicable (loops).
 FOR k, x, lo, hi IN
  SELECT 'recall.' || t.key, t.value, 'found', 'total' FROM jsonb_each(CASE WHEN v ? 'recall' THEN v -> 'recall' ELSE '{}'::jsonb END) AS t
  UNION ALL SELECT 'precision', v -> 'precision', 'real', 'shown' WHERE v ? 'precision'
  UNION ALL SELECT 'loops', v -> 'loops', 'covered', 'applicable' WHERE v ? 'loops'
 LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' THEN
   RETURN k || ' must be {' || lo || ', ' || hi || '}, whole numbers, ' || lo || ' at most ' || hi;
  END IF;
  IF NOT (x ? lo AND x ? hi) OR (SELECT count(*) FROM jsonb_object_keys(x)) <> 2 THEN
   RETURN k || ' must be {' || lo || ', ' || hi || '}, whole numbers, ' || lo || ' at most ' || hi;
  END IF;
  IF jsonb_typeof(x -> lo) IS DISTINCT FROM 'number' OR jsonb_typeof(x -> hi) IS DISTINCT FROM 'number' THEN
   RETURN k || ' must be {' || lo || ', ' || hi || '}, whole numbers, ' || lo || ' at most ' || hi;
  END IF;
  IF (x -> lo)::text !~ '^[0-9]{1,6}$' OR (x -> hi)::text !~ '^[0-9]{1,6}$' THEN
   RETURN k || ' must be {' || lo || ', ' || hi || '}, whole numbers, ' || lo || ' at most ' || hi;
  END IF;
  IF (x ->> lo)::integer > (x ->> hi)::integer THEN
   RETURN k || ' must be {' || lo || ', ' || hi || '}, whole numbers, ' || lo || ' at most ' || hi;
  END IF;
 END LOOP;
 IF v ? 'rows' THEN
  x := v -> 'rows';
  IF jsonb_typeof(x) IS DISTINCT FROM 'array' THEN RETURN 'rows must be 1 to 25 {t, id} row ids'; END IF;
  IF jsonb_array_length(x) NOT BETWEEN 1 AND 25
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(x) AS e(r) WHERE jsonb_typeof(e.r) IS DISTINCT FROM 'object') THEN
   RETURN 'rows must be 1 to 25 {t, id} row ids';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(x) AS e(r)
             WHERE NOT (e.r ? 't' AND e.r ? 'id') OR (SELECT count(*) FROM jsonb_object_keys(e.r)) <> 2
                OR jsonb_typeof(e.r -> 't') <> 'string' OR jsonb_typeof(e.r -> 'id') <> 'string'
                OR NOT e.r ->> 't' = ANY (row_tables) OR e.r ->> 'id' !~ '^[A-Za-z0-9_-]{1,64}$') THEN
   RETURN 'rows must be 1 to 25 {t, id} row ids';
  END IF;
 END IF;
 RETURN NULL;
END $fn$;
COMMENT ON FUNCTION public.context_grade_verdicts_problem(text, text, jsonb) IS
 'Context grades (20261007090000): the shape of one graded unit''s verdicts (the check on context_grades.verdicts). Null when well formed, else what is wrong. kind ledger (one ledger item): verbatim, parties, supported (T5: pass or fail) and unsafe (T8: 0 or 1), required. kind story (one job''s story card): first_line (T6: pass or fail) and unsafe (T8: unsafe lines, a count), required; timeline (T1), record_loops (T2), money (every amount to the cent), dates (every weekday right), honesty (not_known names the real gaps, nothing more certain than the rows) as pass or fail; recall (T3: {money, record, message}, each {found, total}); precision (T4: {real, shown}); first_line_set (known or unseen); orientation (1 to 5). kind agent (one T7 call): unit where_at, last_told, owed or period needs answer (correct or wrong), unit story needs loops ({covered, applicable}); both need unsafe (a count) and may carry action_cards (a count) and story_tool (true or false). Any kind may carry unsafe_classes (distinct T8 classes 1 to 4, only with unsafe above 0) and rows (1 to 25 {t, id} proving rows). No other key; at most 4096 bytes. Codes, counts and ids only, never words: the key''s loop ids are not stored either (some carry a first name), only how many loops were covered.';

-- 3. The one rule for whether a graded unit passes (malformed verdicts never do).
--   ledger: verbatim, parties and supported all pass and the item is not unsafe.
--   story:  the first line passes, no unsafe line, and every other test graded
--           on the job passes: timeline, record loops, money, dates, honesty,
--           and every money and record key loop found. Message recall (T3) and
--           precision (T4) have sample-wide bars, so they are counted in the
--           sample's tests, not here.
--   agent:  no unsafe line and no action card raised, and the answer is
--           correct (the story call: every applicable key loop covered).
CREATE OR REPLACE FUNCTION public.context_grade_passed(p_kind text, p_unit text, p_verdicts jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT CASE WHEN public.context_grade_verdicts_problem(p_kind, p_unit, p_verdicts) IS NOT NULL THEN false
  ELSE coalesce(CASE p_kind
   WHEN 'ledger' THEN p_verdicts ->> 'verbatim' = 'pass' AND p_verdicts ->> 'parties' = 'pass'
    AND p_verdicts ->> 'supported' = 'pass' AND (p_verdicts ->> 'unsafe')::integer = 0
   WHEN 'story' THEN p_verdicts ->> 'first_line' = 'pass' AND (p_verdicts ->> 'unsafe')::integer = 0
    AND coalesce(p_verdicts ->> 'timeline', 'pass') = 'pass' AND coalesce(p_verdicts ->> 'record_loops', 'pass') = 'pass'
    AND coalesce(p_verdicts ->> 'money', 'pass') = 'pass' AND coalesce(p_verdicts ->> 'dates', 'pass') = 'pass'
    AND coalesce(p_verdicts ->> 'honesty', 'pass') = 'pass'
    AND coalesce((p_verdicts #>> '{recall,money,found}')::integer = (p_verdicts #>> '{recall,money,total}')::integer, true)
    AND coalesce((p_verdicts #>> '{recall,record,found}')::integer = (p_verdicts #>> '{recall,record,total}')::integer, true)
   WHEN 'agent' THEN (p_verdicts ->> 'unsafe')::integer = 0 AND coalesce((p_verdicts ->> 'action_cards')::integer, 0) = 0
    AND CASE WHEN p_unit = 'story'
             THEN (p_verdicts #>> '{loops,covered}')::integer = (p_verdicts #>> '{loops,applicable}')::integer
             ELSE p_verdicts ->> 'answer' = 'correct' END
  END, false) END
$fn$;
COMMENT ON FUNCTION public.context_grade_passed(text, text, jsonb) IS
 'Context grades (20261007090000): the one rule for whether a graded unit passes; malformed verdicts (context_grade_verdicts_problem not null) never pass. ledger: verbatim, parties and supported all pass and unsafe 0. story: first_line passes, unsafe 0, and timeline, record_loops, money, dates and honesty are not fail, and recall money and record found equals total where graded (message recall and precision have sample-wide bars and are counted in the sample''s tests instead). agent: unsafe 0, no action card, and answer correct (unit story: loops covered equals applicable). Service role only.';

-- 4. The graded units.
CREATE TABLE IF NOT EXISTS public.context_grades (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 -- ledger (one ledger item), story (one job's story card) or agent (one T7 agent call).
 kind text NOT NULL,
 -- One grading run, for example the grade folder's UTC stamp. A sample of a kind loads once.
 sample_id text NOT NULL,
 job_id uuid NOT NULL REFERENCES public.jobs(id),
 -- What was graded on the job: ledger, the ledger item's id; story, 'story'; agent, the T7 question
 -- (where_at, last_told, owed, story, period).
 unit text NOT NULL,
 -- The reading graded (ledger: always; story: the reading the story showed, null for records only)
 -- and the model that made it (context_ledger_generations.model), for per-reader results.
 generation_id uuid,
 reading_model text,
 -- ledger: the item's type, one of the published kinds.
 item_type text,
 -- The sample stratum the unit was drawn in, when the draw had strata (part B: claude, cloud, ...).
 stratum text,
 -- Counts toward the bar. false for a unit reported but not gated (the T7 optional calls).
 gated boolean NOT NULL DEFAULT true,
 -- Per test: codes, counts and row ids only (context_grade_verdicts_problem).
 verdicts jsonb NOT NULL,
 -- Who graded it (grader-1, critic, or person:<user id>), the instant the system output and the
 -- records were read as of (the grade instant T_g; for T7 the run's start), and when it was graded.
 grader text NOT NULL,
 as_of timestamptz NOT NULL,
 graded_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT context_grades_kind CHECK (kind IN ('ledger', 'story', 'agent')),
 CONSTRAINT context_grades_sample_id CHECK (sample_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$'),
 -- A CASE, never an OR of comparisons: an unknown kind must refuse, not pass as unknown.
 CONSTRAINT context_grades_unit CHECK (CASE kind
  WHEN 'ledger' THEN unit ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  WHEN 'story' THEN unit = 'story'
  WHEN 'agent' THEN unit IN ('where_at', 'last_told', 'owed', 'story', 'period')
  ELSE false END),
 CONSTRAINT context_grades_reading CHECK ((generation_id IS NULL) = (reading_model IS NULL)
  AND (kind <> 'ledger' OR generation_id IS NOT NULL)
  AND (reading_model IS NULL OR reading_model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$')),
 CONSTRAINT context_grades_item_type CHECK ((kind = 'ledger') = (item_type IS NOT NULL)
  AND (item_type IS NULL OR item_type IN ('commitment', 'request', 'claim', 'issue', 'constraint', 'dependency', 'agreement',
   'event', 'phase_note'))),
 CONSTRAINT context_grades_stratum CHECK (stratum IS NULL OR stratum ~ '^[a-z0-9][a-z0-9_:-]{0,39}$'),
 CONSTRAINT context_grades_verdicts CHECK (public.context_grade_verdicts_problem(kind, unit, verdicts) IS NULL),
 CONSTRAINT context_grades_grader CHECK (grader ~ '^(person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9._-]{0,63})$'),
 -- Graded after the instant it was graded against, and never later than it was stored.
 CONSTRAINT context_grades_times CHECK (as_of <= graded_at AND graded_at <= created_at + interval '10 minutes'),
 CONSTRAINT context_grades_unit_once UNIQUE (kind, sample_id, job_id, unit)
);
CREATE INDEX IF NOT EXISTS context_grades_job ON public.context_grades (job_id);
CREATE INDEX IF NOT EXISTS context_grades_kind_graded ON public.context_grades (kind, graded_at DESC);
ALTER TABLE public.context_grades ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_grades FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.context_grades TO service_role;
COMMENT ON TABLE public.context_grades IS
 'Context grades (20261007090000): one row per graded unit of one sample, done definition rows 7, 8 and 9 (owner ruling 7 Oct 2026). kind ledger: one ledger item (T5, T8); story: one job''s story card (T1 to T8, money, dates, honesty, orientation); agent: one T7 agent call (where_at, last_told, owed, story, period). verdicts per test are codes, counts and row ids only (context_grade_verdicts_problem), never words; whether a unit passes is context_grade_passed; the newest sample of each kind is context_grades_newest. Loaded by scripts/context-grades-load.sql with the owner''s go; a sample is removed whole by scripts/context-grades-load-undo.sql. Service role reads and inserts; nobody else may do anything.';

-- 5. Every sample loaded by p_as_of, with its pass share, size and per-test counts.
CREATE OR REPLACE FUNCTION public.context_grade_samples(p_as_of timestamptz DEFAULT now())
RETURNS TABLE (kind text, sample_id text, newest boolean, graded_at timestamptz, as_of timestamptz, units integer, passed integer,
 pass_pct numeric, jobs integer, optional_units integer, optional_passed integer, unsafe_lines integer, graders text[],
 tests jsonb, breakdown jsonb, readings jsonb)
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $fn$
 WITH g AS (
  SELECT r.kind, r.sample_id, r.job_id, r.unit, r.generation_id, coalesce(r.reading_model, 'none') AS reading_model, r.item_type,
         coalesce(r.stratum, 'none') AS stratum, r.gated, r.verdicts AS v, r.grader, r.as_of, r.graded_at,
         public.context_grade_passed(r.kind, r.unit, r.verdicts) AS ok
  FROM public.context_grades r
  WHERE r.created_at <= coalesce(p_as_of, now())
 ), s AS (
  SELECT g.kind, g.sample_id, max(g.graded_at) AS graded_at, min(g.as_of) AS as_of,
   count(*) FILTER (WHERE g.gated)::integer AS units,
   count(*) FILTER (WHERE g.gated AND g.ok)::integer AS passed,
   count(DISTINCT g.job_id) FILTER (WHERE g.gated)::integer AS jobs,
   count(*) FILTER (WHERE NOT g.gated)::integer AS optional_units,
   count(*) FILTER (WHERE NOT g.gated AND g.ok)::integer AS optional_passed,
   sum((g.v ->> 'unsafe')::integer)::integer AS unsafe_lines,
   array_agg(DISTINCT g.grader COLLATE "C" ORDER BY g.grader COLLATE "C") AS graders,
   CASE g.kind
    WHEN 'ledger' THEN jsonb_build_object(
     'verbatim', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated),
                                    'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'verbatim' = 'pass')),
     'parties', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated),
                                   'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'parties' = 'pass')),
     'supported', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated),
                                     'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'supported' = 'pass')),
     'unsafe', jsonb_build_object('units', count(*) FILTER (WHERE (g.v ->> 'unsafe')::integer > 0),
                                  'lines', sum((g.v ->> 'unsafe')::integer)))
    WHEN 'story' THEN jsonb_build_object(
     'timeline', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v ? 'timeline'),
                                    'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'timeline' = 'pass')),
     'record_loops', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v ? 'record_loops'),
                                        'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'record_loops' = 'pass')),
     'recall', jsonb_build_object(
      'money', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v #> '{recall,money}' IS NOT NULL),
                                  'found', coalesce(sum((g.v #>> '{recall,money,found}')::integer) FILTER (WHERE g.gated), 0),
                                  'total', coalesce(sum((g.v #>> '{recall,money,total}')::integer) FILTER (WHERE g.gated), 0)),
      'record', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v #> '{recall,record}' IS NOT NULL),
                                   'found', coalesce(sum((g.v #>> '{recall,record,found}')::integer) FILTER (WHERE g.gated), 0),
                                   'total', coalesce(sum((g.v #>> '{recall,record,total}')::integer) FILTER (WHERE g.gated), 0)),
      'message', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v #> '{recall,message}' IS NOT NULL),
                                    'found', coalesce(sum((g.v #>> '{recall,message,found}')::integer) FILTER (WHERE g.gated), 0),
                                    'total', coalesce(sum((g.v #>> '{recall,message,total}')::integer) FILTER (WHERE g.gated), 0))),
     'precision', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v ? 'precision'),
                                     'real', coalesce(sum((g.v #>> '{precision,real}')::integer) FILTER (WHERE g.gated), 0),
                                     'shown', coalesce(sum((g.v #>> '{precision,shown}')::integer) FILTER (WHERE g.gated), 0)),
     'first_line', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated),
      'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'first_line' = 'pass'),
      'known', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v ->> 'first_line_set' = 'known'),
                                  'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'first_line_set' = 'known' AND g.v ->> 'first_line' = 'pass')),
      'unseen', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v ->> 'first_line_set' = 'unseen'),
                                   'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'first_line_set' = 'unseen' AND g.v ->> 'first_line' = 'pass'))),
     'money', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v ? 'money'),
                                 'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'money' = 'pass')),
     'dates', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v ? 'dates'),
                                 'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'dates' = 'pass')),
     'honesty', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v ? 'honesty'),
                                   'passed', count(*) FILTER (WHERE g.gated AND g.v ->> 'honesty' = 'pass')),
     'orientation', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.v ? 'orientation'),
      'mean', round(avg((g.v ->> 'orientation')::numeric) FILTER (WHERE g.gated), 1),
      'lowest', min((g.v ->> 'orientation')::integer) FILTER (WHERE g.gated)),
     'unsafe', jsonb_build_object('units', count(*) FILTER (WHERE (g.v ->> 'unsafe')::integer > 0),
                                  'lines', sum((g.v ->> 'unsafe')::integer)))
    ELSE jsonb_build_object(
     'baseline', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.unit IN ('where_at', 'last_told', 'owed')),
                                    'passed', count(*) FILTER (WHERE g.gated AND g.ok AND g.unit IN ('where_at', 'last_told', 'owed'))),
     'story', jsonb_build_object('graded', count(*) FILTER (WHERE g.gated AND g.unit = 'story'),
      'passed', count(*) FILTER (WHERE g.gated AND g.ok AND g.unit = 'story'),
      'loops_covered', coalesce(sum((g.v #>> '{loops,covered}')::integer) FILTER (WHERE g.gated), 0),
      'loops_applicable', coalesce(sum((g.v #>> '{loops,applicable}')::integer) FILTER (WHERE g.gated), 0)),
     'optional_story', jsonb_build_object('graded', count(*) FILTER (WHERE NOT g.gated AND g.unit = 'story'),
      'passed', count(*) FILTER (WHERE NOT g.gated AND g.ok AND g.unit = 'story'),
      'loops_covered', coalesce(sum((g.v #>> '{loops,covered}')::integer) FILTER (WHERE NOT g.gated), 0),
      'loops_applicable', coalesce(sum((g.v #>> '{loops,applicable}')::integer) FILTER (WHERE NOT g.gated), 0)),
     'period', jsonb_build_object('graded', count(*) FILTER (WHERE g.unit = 'period'),
                                  'passed', count(*) FILTER (WHERE g.ok AND g.unit = 'period')),
     'story_tool_missed', count(*) FILTER (WHERE g.v -> 'story_tool' = 'false'::jsonb),
     'action_cards', coalesce(sum((g.v ->> 'action_cards')::integer), 0),
     'unsafe', jsonb_build_object('units', count(*) FILTER (WHERE (g.v ->> 'unsafe')::integer > 0),
                                  'lines', sum((g.v ->> 'unsafe')::integer)))
   END AS tests
  FROM g GROUP BY g.kind, g.sample_id
 ), dims AS (
  SELECT g.kind, g.sample_id, d.dim, d.k,
   count(*) FILTER (WHERE g.gated)::integer AS units, count(*) FILTER (WHERE g.gated AND g.ok)::integer AS passed,
   count(*) FILTER (WHERE NOT g.gated)::integer AS optional_units, count(*) FILTER (WHERE NOT g.gated AND g.ok)::integer AS optional_passed
  FROM g CROSS JOIN LATERAL (VALUES ('by_reader', g.reading_model), ('by_stratum', g.stratum),
   ('by_type', CASE WHEN g.kind = 'ledger' THEN g.item_type END), ('by_question', CASE WHEN g.kind = 'agent' THEN g.unit END)) AS d(dim, k)
  WHERE d.k IS NOT NULL
  GROUP BY g.kind, g.sample_id, d.dim, d.k
 ), bd AS (
  SELECT x.kind, x.sample_id, jsonb_object_agg(x.dim, x.v) AS breakdown
  FROM (SELECT dims.kind, dims.sample_id, dims.dim,
               jsonb_object_agg(dims.k, jsonb_build_object('units', dims.units, 'passed', dims.passed,
                'optional_units', dims.optional_units, 'optional_passed', dims.optional_passed)) AS v
        FROM dims GROUP BY dims.kind, dims.sample_id, dims.dim) x
  GROUP BY x.kind, x.sample_id
 ), rd AS (
  -- The readings graded, as they stand now (a reading's status is not kept by instant, so this part is not replayed).
  SELECT x.kind, x.sample_id, jsonb_build_object('graded', count(*),
   'live', count(*) FILTER (WHERE lg.status = 'live'), 'shadow', count(*) FILTER (WHERE lg.status = 'shadow'),
   'retired', count(*) FILTER (WHERE lg.status = 'retired'),
   'other', count(*) FILTER (WHERE lg.status NOT IN ('live', 'shadow', 'retired')), 'missing', count(*) FILTER (WHERE lg.id IS NULL)) AS readings
  FROM (SELECT DISTINCT g.kind, g.sample_id, g.generation_id FROM g WHERE g.generation_id IS NOT NULL) x
  LEFT JOIN public.context_ledger_generations lg ON lg.id = x.generation_id
  GROUP BY x.kind, x.sample_id
 )
 SELECT s.kind, s.sample_id,
  row_number() OVER (PARTITION BY s.kind ORDER BY s.graded_at DESC, s.sample_id COLLATE "C" DESC) = 1,
  s.graded_at, s.as_of, s.units, s.passed,
  CASE WHEN s.units > 0 THEN (floor(1000.0 * s.passed / s.units) / 10)::numeric(4, 1) END,
  s.jobs, s.optional_units, s.optional_passed, s.unsafe_lines, s.graders, s.tests, coalesce(bd.breakdown, '{}'::jsonb),
  coalesce(rd.readings, jsonb_build_object('graded', 0, 'live', 0, 'shadow', 0, 'retired', 0, 'other', 0, 'missing', 0))
 FROM s LEFT JOIN bd ON bd.kind = s.kind AND bd.sample_id = s.sample_id
 LEFT JOIN rd ON rd.kind = s.kind AND rd.sample_id = s.sample_id
 ORDER BY s.kind COLLATE "C", s.graded_at DESC, s.sample_id COLLATE "C" DESC
$fn$;
COMMENT ON FUNCTION public.context_grade_samples(timestamptz) IS
 'Context grades (20261007090000): read only. Every sample of every kind stored by p_as_of (rows created at or before it; default now), one row each: kind, sample_id, newest (the newest of its kind: latest graded_at, then sample_id), graded_at (the sample''s latest), as_of (its earliest), units (gated units graded), passed (gated units that pass context_grade_passed), pass_pct (100 x passed / units, rounded down to 0.1, never up; null with no units), jobs (distinct jobs among gated units), optional_units and optional_passed (units reported, not gated), unsafe_lines (T8 over every unit), graders, tests (per-test counts for the kind: ledger verbatim, parties, supported and unsafe; story timeline, record_loops, recall money/record/message found of total, precision real of shown, first_line overall and known/unseen, money, dates, honesty, orientation mean and lowest, unsafe; agent baseline, story with loops covered of applicable, optional_story, period, story_tool_missed, action_cards, unsafe), breakdown (by_reader, by_stratum, by_type for ledger, by_question for agent: units, passed, optional_units, optional_passed) and readings (the distinct readings graded and how many of them are live, shadow, retired, other or missing now; read as they stand now, not replayed to p_as_of). No bar is applied here. Service role only.';

-- 6. The scorecard's read: the newest sample of each kind, always three rows.
CREATE OR REPLACE FUNCTION public.context_grades_newest(p_as_of timestamptz DEFAULT now())
RETURNS TABLE (kind text, samples integer, sample_id text, graded_at timestamptz, as_of timestamptz, units integer, passed integer,
 pass_pct numeric, jobs integer, optional_units integer, optional_passed integer, unsafe_lines integer, graders text[],
 tests jsonb, breakdown jsonb, readings jsonb)
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $fn$
 WITH s AS (SELECT * FROM public.context_grade_samples(p_as_of))
 SELECT k.kind, (SELECT count(*)::integer FROM s c WHERE c.kind = k.kind), n.sample_id, n.graded_at, n.as_of,
  coalesce(n.units, 0), coalesce(n.passed, 0), n.pass_pct, coalesce(n.jobs, 0), coalesce(n.optional_units, 0),
  coalesce(n.optional_passed, 0), coalesce(n.unsafe_lines, 0), coalesce(n.graders, '{}'::text[]), coalesce(n.tests, '{}'::jsonb),
  coalesce(n.breakdown, '{}'::jsonb),
  coalesce(n.readings, jsonb_build_object('graded', 0, 'live', 0, 'shadow', 0, 'retired', 0, 'other', 0, 'missing', 0))
 FROM (VALUES ('ledger', 1), ('story', 2), ('agent', 3)) AS k(kind, ord)
 LEFT JOIN s n ON n.kind = k.kind AND n.newest
 ORDER BY k.ord
$fn$;
COMMENT ON FUNCTION public.context_grades_newest(timestamptz) IS
 'Context grades (20261007090000): read only. The newest sample of each kind stored by p_as_of (default now), always three rows in the order ledger (row 7: the ledger items graded), story (row 8: the job story card graded), agent (row 9 and 9+: the T7 agent test): samples (how many samples of the kind are stored), then the newest sample''s columns as context_grade_samples gives them (sample_id, graded_at, as_of, units, passed, pass_pct, jobs, optional_units, optional_passed, unsafe_lines, graders, tests, breakdown, readings); a kind with no sample has sample_id null, counts 0, pass_pct null, empty tests and breakdown, and readings all 0. No bar is applied here: the scorecard''s policy holds the bars. Service role only.';

-- 7. Access: service role only.
REVOKE ALL ON FUNCTION public.context_item_kinds() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_grade_verdicts_problem(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_grade_passed(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_grade_samples(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_grades_newest(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_item_kinds() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_grade_verdicts_problem(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_grade_passed(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_grade_samples(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_grades_newest(timestamptz) TO service_role;
