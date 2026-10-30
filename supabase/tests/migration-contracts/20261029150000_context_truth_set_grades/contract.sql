-- Contract for 20261029150000_context_truth_set_grades (v2): the TP-19 set headers and grades, tied together by a
-- foreign key; the draw digest; the exact weighted ratio; and the per-set results, read by hand. Every fixture row is
-- synthetic and rolled back. Every instant is pinned (the sets are drawn as of 2031 and created_at is given), so no
-- column default (now()) reaches an assertion.

-- 1. Shape: exact columns, RLS on with no policy, the indexes, this migration's comments, and the grants. The
-- setup gives this database Supabase's default privileges (EXECUTE on new functions and ALL on new tables to anon
-- and authenticated), proved here first, so the checks below prove the migration's REVOKEs.
BEGIN;
CREATE FUNCTION public.zz_truth_set_default_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1';
DO $$
BEGIN
 IF NOT has_function_privilege('anon', 'public.zz_truth_set_default_probe()', 'EXECUTE')
  OR NOT has_function_privilege('authenticated', 'public.zz_truth_set_default_probe()', 'EXECUTE') THEN
  RAISE EXCEPTION 'truth set contract: the setup''s default privileges are not in force, so the grant checks prove nothing';
 END IF;
END $$;
ROLLBACK;

DO $$
DECLARE cols text; f text; t text;
BEGIN
 SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid = 'public.context_truth_set_sets'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
 IF cols IS DISTINCT FROM 'set_id:text,kind:text,purpose:text,as_of:timestamp with time zone,drawn:integer,draw_digest:text,'
   'pool_rows:integer,pool_all:integer,screened:integer,excl_count:integer,excl_sha256:text,strata:jsonb,grader:text,'
   'graded_at:timestamp with time zone,created_at:timestamp with time zone' THEN
  RAISE EXCEPTION 'truth set contract: unexpected set columns %', cols;
 END IF;
 SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid = 'public.context_truth_set_grades'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
 IF cols IS DISTINCT FROM 'id:uuid,set_id:text,kind:text,purpose:text,as_of:timestamp with time zone,drawn:integer,'
   'draw_digest:text,pos:integer,stratum:text,xero_invoice_id:text,amount_ex:numeric(12,2),event_id:uuid,job_id:uuid,'
   'story_text_id:uuid,generation_id:uuid,system_state:text,system_detail:text,system_source:text,system_job_ids:uuid[],'
   'system_job_ex:numeric(12,2)[],system_non_job_ex:numeric(12,2),system_holding_job_ids:uuid[],answer:text,reason:text,'
   'answer_job_ids:uuid[],answer_job_ex:numeric(12,2)[],non_job_bucket:text,money_items:integer,money_right:integer,'
   'unsafe_lines:integer,created_at:timestamp with time zone' THEN
  RAISE EXCEPTION 'truth set contract: unexpected grade columns %', cols;
 END IF;
 FOREACH t IN ARRAY ARRAY['public.context_truth_set_sets', 'public.context_truth_set_grades'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN
   RAISE EXCEPTION 'truth set contract: row level security is off on %', t;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = t::regclass) THEN RAISE EXCEPTION 'truth set contract: % carries a policy', t; END IF;
  IF coalesce(obj_description(t::regclass, 'pg_class'), '') NOT LIKE 'Context truth-set grades (20261029150000, v2)%' THEN
   RAISE EXCEPTION 'truth set contract: the comment on % does not name the migration', t;
  END IF;
  IF has_table_privilege('anon', t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_table_privilege('authenticated', t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = t::regclass AND a.grantee = 0) THEN
   RAISE EXCEPTION 'truth set contract: PUBLIC, anon or authenticated holds a privilege on %', t;
  END IF;
  IF NOT has_table_privilege('service_role', t, 'SELECT') OR NOT has_table_privilege('service_role', t, 'INSERT')
   OR has_table_privilege('service_role', t, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
   RAISE EXCEPTION 'truth set contract: service_role must hold SELECT and INSERT only on %', t;
  END IF;
 END LOOP;
 IF (SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public'
     AND tablename IN ('context_truth_set_sets', 'context_truth_set_grades')) IS DISTINCT FROM
    'context_truth_set_grades_bill_once,context_truth_set_grades_msg_once,context_truth_set_grades_pkey,'
    'context_truth_set_grades_pos_once,context_truth_set_grades_set_key,context_truth_set_grades_story_once,'
    'context_truth_set_sets_draw_key,context_truth_set_sets_newest,context_truth_set_sets_pkey' THEN
  RAISE EXCEPTION 'truth set contract: unexpected indexes';
 END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'context\_truth\_set\_%') <> 7 THEN
  RAISE EXCEPTION 'truth set contract: expected exactly seven context_truth_set_ functions';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_truth_set_ids_ok(uuid[])', 'public.context_truth_set_ex_ok(numeric[],integer)',
   'public.context_truth_set_ex_sum(numeric[])', 'public.context_truth_set_strata_ok(text,jsonb,integer,integer)',
   'public.context_truth_set_draw_digest(jsonb)', 'public.context_truth_set_ratio(jsonb,bigint,bigint)',
   'public.context_truth_set_results(timestamptz)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'truth set contract: % is missing', f; END IF;
  IF coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '') NOT LIKE 'Context truth-set grades (20261029150000, v2)%' THEN
   RAISE EXCEPTION 'truth set contract: % comment does not name the migration', f;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE')
   OR (SELECT proacl FROM pg_proc WHERE oid = to_regprocedure(f)) IS NULL
   OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure(f) AND a.grantee = 0) THEN
   RAISE EXCEPTION 'truth set contract: % must run for service_role only (PUBLIC, anon and authenticated revoked)', f;
  END IF;
 END LOOP;
 IF (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.context_truth_set_draw_digest(jsonb)')) <> 'i'
  OR (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.context_truth_set_ratio(jsonb,bigint,bigint)')) <> 'i'
  OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.context_truth_set_results(timestamptz)')) THEN
  RAISE EXCEPTION 'truth set contract: the digest and ratio must be IMMUTABLE and the results SECURITY DEFINER';
 END IF;
END $$;

-- 2. The digest: the value the draw scripts and tp19_sheets.py compute (a sha256 pinned here), row order does not
-- matter, any edit moves it (the exclusions' sha256 and the placement stratum included), and a mixed, short-fielded
-- or empty draw has none.
DO $$
DECLARE
 d jsonb := '[{"set_id": "tp19-bill-20310315t040000z-b1r1-d180-00000000000000aa", "kind": "bill", "as_of_utc": "2031-03-15T04:00:00Z", "drawn": "2", "pool_rows": "9", "pool_all": "9", "screened": "9", "excl_count": "0", "excl_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "pos": "1", "item_id": "bill-a", "stratum": "biggest", "stratum_rows": "1", "stratum_drawn": "1", "amount_ex": "6000.00", "system_state": "placed", "system_detail": "balanced", "system_source": "rules", "system_job_ids": "a3100000-0000-4000-8000-000000000001", "system_job_ex": "6000.00", "system_non_job_ex": "0.00", "system_holding_job_ids": "", "story_text_id": "", "generation_id": ""}, {"set_id": "tp19-bill-20310315t040000z-b1r1-d180-00000000000000aa", "kind": "bill", "as_of_utc": "2031-03-15T04:00:00Z", "drawn": "2", "pool_rows": "9", "pool_all": "9", "screened": "9", "excl_count": "0", "excl_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "pos": "2", "item_id": "bill-b", "stratum": "random", "stratum_rows": "8", "stratum_drawn": "1", "amount_ex": "100.50", "system_state": "unplaced", "system_detail": "none", "system_source": "none", "system_job_ids": "", "system_job_ex": "", "system_non_job_ex": "0.00", "system_holding_job_ids": "", "story_text_id": "", "generation_id": ""}]';
 want constant text := '0930b820fda005cbe76b972ac04f10d562ec4d673add1f5df40b67e45ae86c80';
 e text := repeat('f', 64);
 k text;
BEGIN
 IF public.context_truth_set_draw_digest(d) IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'truth set contract: the digest is % not %', public.context_truth_set_draw_digest(d), want;
 END IF;
 IF public.context_truth_set_draw_digest(jsonb_build_array(d -> 1, d -> 0)) IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'truth set contract: the digest depends on the order the rows were saved in';
 END IF;
 IF public.context_truth_set_draw_digest(jsonb_set(d, '{1,amount_ex}', '"100.51"')) = want
  OR public.context_truth_set_draw_digest(jsonb_set(d, '{0,system_detail}', '"remainder"')) = want
  OR public.context_truth_set_draw_digest(jsonb_set(d, '{0,system_job_ex}', '"5999.99"')) = want
  OR public.context_truth_set_draw_digest(jsonb_set(d, '{0,system_holding_job_ids}', '"a3100000-0000-4000-8000-000000000001"')) = want
  OR public.context_truth_set_draw_digest(jsonb_set(d, '{0,stratum_rows}', '"2"')) = want
  OR public.context_truth_set_draw_digest(jsonb_build_array(d -> 0)) = want THEN
  RAISE EXCEPTION 'truth set contract: an edited or short draw keeps the digest';
 END IF;
 -- A header field edited on every row moves the digest (the exclusions' sha256 and the pool sizes included).
 FOREACH k IN ARRAY ARRAY['excl_sha256', 'excl_count', 'pool_all', 'screened', 'as_of_utc'] LOOP
  IF public.context_truth_set_draw_digest(jsonb_set(jsonb_set(d, ARRAY['0', k], to_jsonb(e)), ARRAY['1', k], to_jsonb(e))) = want THEN
   RAISE EXCEPTION 'truth set contract: the header field % is not in the digest', k;
  END IF;
 END LOOP;
 IF public.context_truth_set_draw_digest(jsonb_set(d, '{1,set_id}', '"tp19-bill-20310315t040000z-other"')) IS NOT NULL
  OR public.context_truth_set_draw_digest(jsonb_set(d, '{1,excl_sha256}', to_jsonb(e))) IS NOT NULL
  OR public.context_truth_set_draw_digest(d #- '{1,system_source}') IS NOT NULL
  OR public.context_truth_set_draw_digest(d #- '{0,generation_id}') IS NOT NULL
  OR public.context_truth_set_draw_digest('[]') IS NOT NULL OR public.context_truth_set_draw_digest('{}') IS NOT NULL THEN
  RAISE EXCEPTION 'truth set contract: a mixed, short-fielded or empty draw has a digest';
 END IF;
END $$;

-- 3. The exact weighted ratio: integer arithmetic, rounded down, stratum weights, the multiplier, and null on
-- anything malformed.
DO $$
DECLARE got numeric;
BEGIN
 IF public.context_truth_set_ratio('[{"rows": 1, "drawn": 1, "num": 2, "den": 3}]') IS DISTINCT FROM 0.6666
  OR public.context_truth_set_ratio('[{"rows": 10, "drawn": 3, "num": 0.01, "den": 0.03}]') IS DISTINCT FROM 0.3333
  OR public.context_truth_set_ratio('[{"rows": 1, "drawn": 1, "num": 1, "den": 1}]', 40, 50) IS DISTINCT FROM 0.8000
  OR public.context_truth_set_ratio('[{"rows": 2, "drawn": 2, "num": 1, "den": 2}, {"rows": 10, "drawn": 3, "num": 1, "den": 3}]') IS DISTINCT FROM 0.3611
  OR public.context_truth_set_ratio('[{"rows": 1, "drawn": 1, "num": 1, "den": 1}, {"rows": 99, "drawn": 1, "num": 0, "den": 0}]') IS DISTINCT FROM 1.0000 THEN
  RAISE EXCEPTION 'truth set contract: the weighted ratio is wrong (rounded down, weights rows / drawn)';
 END IF;
 -- 8000 / (8000 + 100 x 10 / 3) = 0.96 exactly: a float or an early rounding would read 0.9599.
 got := public.context_truth_set_ratio('[{"rows": 2, "drawn": 2, "num": 8000, "den": 8000}, {"rows": 10, "drawn": 3, "num": 0, "den": 100}]');
 IF got IS DISTINCT FROM 0.9600 THEN RAISE EXCEPTION 'truth set contract: an exact weighted ratio read %, not 0.9600', got; END IF;
 IF public.context_truth_set_ratio('[{"rows": 1, "drawn": 1, "num": 0, "den": 0}]') IS NOT NULL
  OR public.context_truth_set_ratio('[]') IS NOT NULL
  OR public.context_truth_set_ratio('{"rows": 1}') IS NOT NULL
  OR public.context_truth_set_ratio('[{"rows": 1, "drawn": 0, "num": 1, "den": 1}]') IS NOT NULL
  OR public.context_truth_set_ratio('[{"rows": 1, "drawn": 1, "num": "1", "den": 1}]') IS NOT NULL
  OR public.context_truth_set_ratio('[{"rows": 1, "drawn": 1, "num": 0.001, "den": 1}]') IS NOT NULL
  OR public.context_truth_set_ratio('[{"rows": 1, "drawn": 1, "num": -1, "den": 1}]') IS NOT NULL
  OR public.context_truth_set_ratio('[{"rows": 1.5, "drawn": 1, "num": 1, "den": 1}]') IS NOT NULL
  OR public.context_truth_set_ratio('[{"rows": 1, "drawn": 1, "num": 1, "den": 1}]', 1, 0) IS NOT NULL THEN
  RAISE EXCEPTION 'truth set contract: a malformed or zero-denominator ratio has a value';
 END IF;
END $$;

-- 4. The checks: every malformed header or grade refuses, by its own constraint; every well-formed one is accepted.
BEGIN;
INSERT INTO public.context_truth_set_sets (set_id, kind, purpose, as_of, drawn, draw_digest, pool_rows, pool_all, screened, excl_count,
 excl_sha256, strata, grader, graded_at, created_at) VALUES
 ('tp19-bill-20310315t040000z-check', 'bill', 'first', '2031-03-15 04:00Z', 5, repeat('a', 64), 9, 9, 9, 0, repeat('e', 64),
  '{"biggest": {"rows": 1, "drawn": 1}, "random": {"rows": 8, "drawn": 4}}', 'grader-1', '2031-03-16 04:00Z', '2031-03-16 04:00Z'),
 ('tp19-msg-20310315t040000z-check', 'message', 'first', '2031-03-15 04:00Z', 4, repeat('a', 64), 40, 50, 20, 0, repeat('e', 64),
  '{"multi_job": {"rows": 5, "drawn": 2}, "single_job": {"rows": 15, "drawn": 2}}', 'grader-1', '2031-03-16 04:00Z', '2031-03-16 04:00Z'),
 ('tp19-story-20310315t040000z-check', 'story', 'first', '2031-03-15 04:00Z', 3, repeat('a', 64), 13, 13, 13, 0, repeat('e', 64),
  '{"finished": {"rows": 10, "drawn": 2}, "in_work": {"rows": 3, "drawn": 1}}', 'grader-1', '2031-03-16 04:00Z', '2031-03-16 04:00Z');
DO $$
DECLARE
 j1 constant text := 'a3100000-0000-4000-8000-000000000001'; j2 constant text := 'a3100000-0000-4000-8000-000000000002';
 hold constant text := 'a3100000-0000-4000-8000-000000000009';
 grade constant text := 'INSERT INTO public.context_truth_set_grades SELECT (jsonb_populate_record(NULL::public.context_truth_set_grades, $1)).*';
 sets constant text := 'INSERT INTO public.context_truth_set_sets SELECT (jsonb_populate_record(NULL::public.context_truth_set_sets, $1)).*';
 common jsonb := jsonb_build_object('purpose', 'first', 'as_of', '2031-03-15T04:00:00Z', 'draw_digest', repeat('a', 64), 'pos', 1,
  'xero_invoice_id', NULL, 'amount_ex', NULL, 'event_id', NULL, 'job_id', NULL, 'story_text_id', NULL, 'generation_id', NULL,
  'system_job_ex', '[]'::jsonb, 'system_non_job_ex', 0, 'system_holding_job_ids', '[]'::jsonb, 'reason', NULL,
  'answer_job_ex', '[]'::jsonb, 'non_job_bucket', NULL, 'money_items', NULL, 'money_right', NULL, 'unsafe_lines', NULL,
  'created_at', '2031-03-16T04:00:00Z');
 b jsonb := common || jsonb_build_object('set_id', 'tp19-bill-20310315t040000z-check', 'kind', 'bill', 'drawn', 5, 'stratum', 'random',
  'xero_invoice_id', 'bill-x', 'amount_ex', 100, 'system_state', 'placed', 'system_detail', 'balanced', 'system_source', 'ai',
  'system_job_ids', jsonb_build_array(j1), 'system_job_ex', '[100]'::jsonb, 'answer', 'job', 'answer_job_ids', jsonb_build_array(j1));
 m jsonb := common || jsonb_build_object('set_id', 'tp19-msg-20310315t040000z-check', 'kind', 'message', 'drawn', 4, 'stratum', 'multi_job',
  'event_id', 'a3100000-0000-4000-800e-000000000001', 'system_state', 'placed', 'system_detail', 'luna', 'system_source', 'ai',
  'system_job_ids', jsonb_build_array(j1), 'answer', 'job', 'answer_job_ids', jsonb_build_array(j1));
 s jsonb := common || jsonb_build_object('set_id', 'tp19-story-20310315t040000z-check', 'kind', 'story', 'drawn', 3, 'stratum', 'finished',
  'job_id', j1, 'story_text_id', 'a3100000-0000-4000-8005-000000000001', 'generation_id', 'a3100000-0000-4000-8006-000000000001',
  'system_state', 'story', 'system_detail', 'written', 'system_source', 'ai', 'system_job_ids', jsonb_build_array(j1),
  'answer', 'graded', 'answer_job_ids', '[]'::jsonb, 'money_items', 4, 'money_right', 3, 'unsafe_lines', 0);
 h jsonb := jsonb_build_object('set_id', 'tp19-bill-20310316t040000z-hdr', 'kind', 'bill', 'purpose', 'weekly', 'as_of', '2031-03-16T04:00:00Z',
  'drawn', 2, 'draw_digest', repeat('a', 64), 'pool_rows', 9, 'pool_all', 9, 'screened', 9, 'excl_count', 0, 'excl_sha256', repeat('e', 64),
  'strata', '{"biggest": {"rows": 1, "drawn": 1}, "random": {"rows": 8, "drawn": 1}}'::jsonb, 'grader', 'grader-1',
  'graded_at', '2031-03-17T04:00:00Z', 'created_at', '2031-03-17T04:00:00Z');
 v record; st text; got text;
BEGIN
 -- Refused grades, each naming the constraint that must refuse it. The first is the break proof's.
 FOR v IN SELECT * FROM (VALUES
   ('bill job with no job', b || '{"answer_job_ids": []}', 'context_truth_set_grades_answer'),
   ('bill split over the bill', b || jsonb_build_object('answer', 'split', 'answer_job_ids', jsonb_build_array(j1, j2), 'answer_job_ex', '[60, 50]'::jsonb), 'context_truth_set_grades_answer'),
   ('bill split short with no bucket', b || jsonb_build_object('answer', 'split', 'answer_job_ids', jsonb_build_array(j1, j2), 'answer_job_ex', '[40, 50]'::jsonb), 'context_truth_set_grades_answer'),
   ('bill split whole with a bucket', b || jsonb_build_object('answer', 'split', 'answer_job_ids', jsonb_build_array(j1, j2), 'answer_job_ex', '[50, 50]'::jsonb, 'non_job_bucket', 'stock'), 'context_truth_set_grades_answer'),
   ('bill split of one job and no rest', b || jsonb_build_object('answer', 'split', 'answer_job_ids', jsonb_build_array(j1), 'answer_job_ex', '[100]'::jsonb), 'context_truth_set_grades_answer'),
   ('bill split with an amount missing', b || jsonb_build_object('answer', 'split', 'answer_job_ids', jsonb_build_array(j1, j2), 'answer_job_ex', '[100]'::jsonb), 'context_truth_set_grades_answer'),
   ('bill split with a cent fraction', b || jsonb_build_object('answer', 'split', 'answer_job_ids', jsonb_build_array(j1, j2), 'answer_job_ex', '[50.005, 49.995]'::jsonb), 'context_truth_set_grades_answer'),
   ('bill job with an amount list', b || '{"answer_job_ex": [100]}', 'context_truth_set_grades_answer'),
   ('bill non_job with no bucket', b || '{"answer": "non_job", "answer_job_ids": []}', 'context_truth_set_grades_answer'),
   ('bill unknown bucket', b || '{"answer": "non_job", "answer_job_ids": [], "non_job_bucket": "lunch"}', 'context_truth_set_grades_answer'),
   ('bill unsure with no reason', b || '{"answer": "unsure", "answer_job_ids": []}', 'context_truth_set_grades_answer'),
   ('bill unknown answer', b || '{"answer": "maybe", "answer_job_ids": []}', 'context_truth_set_grades_answer'),
   ('bill answer naming a holding job', b || jsonb_build_object('system_job_ids', jsonb_build_array(j1, hold), 'system_job_ex', '[60, 40]'::jsonb,
     'system_holding_job_ids', jsonb_build_array(hold), 'answer_job_ids', jsonb_build_array(hold)), 'context_truth_set_grades_answer'),
   ('bill with a story grade', b || '{"money_items": 1}', 'context_truth_set_grades_answer'),
   ('bill with no Xero id', b || '{"xero_invoice_id": null}', 'context_truth_set_grades_kind'),
   ('bill with no amount', b || '{"amount_ex": null}', 'context_truth_set_grades_kind'),
   ('bill with an event', b || '{"event_id": "a3100000-0000-4000-800e-000000000009"}', 'context_truth_set_grades_kind'),
   ('bill in a message stratum', b || '{"stratum": "multi_job"}', 'context_truth_set_grades_kind'),
   ('bill unplaced with a source', b || '{"system_state": "unplaced", "system_detail": "none", "system_job_ids": [], "system_job_ex": []}', 'context_truth_set_grades_kind'),
   ('bill not job related with a job', b || '{"system_detail": "not_job_related", "system_non_job_ex": 100}', 'context_truth_set_grades_kind'),
   ('bill not job related placed by rules', b || '{"system_detail": "not_job_related", "system_source": "rules", "system_job_ids": [], "system_job_ex": [], "system_non_job_ex": 100}', 'context_truth_set_grades_kind'),
   ('bill balanced called partial', b || '{"system_state": "partial"}', 'context_truth_set_grades_kind'),
   ('bill installer_unconfirmed called placed', b || '{"system_detail": "installer_unconfirmed"}', 'context_truth_set_grades_kind'),
   ('bill unknown allocation state', b || '{"system_detail": "mostly"}', 'context_truth_set_grades_kind'),
   ('bill unknown source', b || '{"system_source": "luna"}', 'context_truth_set_grades_kind'),
   ('bill system amount missing', b || '{"system_job_ex": []}', 'context_truth_set_grades_kind'),
   ('bill holding job not among the system''s', b || jsonb_build_object('system_holding_job_ids', jsonb_build_array(hold)), 'context_truth_set_grades_lists'),
   ('bill a job twice', b || jsonb_build_object('answer', 'split', 'answer_job_ids', jsonb_build_array(j1, j1), 'answer_job_ex', '[50, 50]'::jsonb), 'context_truth_set_grades_lists'),
   ('bill a negative non-job part', b || '{"system_non_job_ex": -1}', 'context_truth_set_grades_lists'),
   ('a position past the draw', b || '{"pos": 6}', 'context_truth_set_grades_pos'),
   ('a digest that is not its header''s', b || jsonb_build_object('draw_digest', repeat('b', 64)), 'context_truth_set_grades_set'),
   ('a size that is not its header''s', b || '{"drawn": 6}', 'context_truth_set_grades_set'),
   ('a purpose that is not its header''s', b || '{"purpose": "weekly"}', 'context_truth_set_grades_set'),
   ('message luna placed by rules', m || '{"system_source": "rules"}', 'context_truth_set_grades_kind'),
   ('message other called ai', m || '{"system_detail": "other"}', 'context_truth_set_grades_kind'),
   ('message on two jobs', m || jsonb_build_object('system_job_ids', jsonb_build_array(j1, j2)), 'context_truth_set_grades_kind'),
   ('message on no job', m || '{"system_job_ids": []}', 'context_truth_set_grades_kind'),
   ('message with an amount', m || '{"amount_ex": 10}', 'context_truth_set_grades_kind'),
   ('message unknown stratum', m || '{"system_detail": "guess", "system_source": "rules"}', 'context_truth_set_grades_kind'),
   ('message job with no job', m || '{"answer_job_ids": []}', 'context_truth_set_grades_answer'),
   ('message no_job with a job', m || '{"answer": "no_job"}', 'context_truth_set_grades_answer'),
   ('message unsure with no reason', m || '{"answer": "unsure", "answer_job_ids": []}', 'context_truth_set_grades_answer'),
   ('message with a bucket', m || '{"non_job_bucket": "stock"}', 'context_truth_set_grades_answer'),
   ('message answer naming a holding job', m || jsonb_build_object('system_job_ids', jsonb_build_array(hold), 'system_holding_job_ids', jsonb_build_array(hold),
     'answer_job_ids', jsonb_build_array(hold)), 'context_truth_set_grades_answer'),
   ('story with no pinned written story', s || '{"story_text_id": null}', 'context_truth_set_grades_kind'),
   ('story on another job', s || jsonb_build_object('system_job_ids', jsonb_build_array(j2)), 'context_truth_set_grades_kind'),
   ('story placed by rules', s || '{"system_source": "rules"}', 'context_truth_set_grades_kind'),
   ('story on a holding job', s || jsonb_build_object('system_holding_job_ids', jsonb_build_array(j1)), 'context_truth_set_grades_kind'),
   ('story more right than shown', s || '{"money_right": 5}', 'context_truth_set_grades_answer'),
   ('story with no money count', s || '{"money_items": null}', 'context_truth_set_grades_answer'),
   ('story negative unsafe lines', s || '{"unsafe_lines": -1}', 'context_truth_set_grades_answer'),
   ('story answered as a job', s || '{"answer": "job"}', 'context_truth_set_grades_answer')
  ) AS x(label, row_, con) LOOP
  BEGIN
   EXECUTE grade USING v.row_ || jsonb_build_object('id', gen_random_uuid());
   RAISE EXCEPTION USING ERRCODE = 'P0097', MESSAGE = 'accepted';
  EXCEPTION WHEN SQLSTATE 'P0097' THEN RAISE EXCEPTION 'truth set contract: % was accepted', v.label;
   WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, got = CONSTRAINT_NAME;
    IF st NOT IN ('23514', '23503') OR got IS DISTINCT FROM v.con THEN
     RAISE EXCEPTION 'truth set contract: % refused by % (%) not %', v.label, got, st, v.con;
    END IF;
  END;
 END LOOP;
 -- Accepted grades (each in a subtransaction, so the next one starts clean).
 FOR v IN SELECT * FROM (VALUES
   ('bill job', b),
   ('bill split on two jobs', b || jsonb_build_object('answer', 'split', 'answer_job_ids', jsonb_build_array(j1, j2), 'answer_job_ex', '[60, 40]'::jsonb)),
   ('bill split with a rest', b || jsonb_build_object('answer', 'split', 'answer_job_ids', jsonb_build_array(j1), 'answer_job_ex', '[60]'::jsonb, 'non_job_bucket', 'stock')),
   ('bill non_job', b || '{"answer": "non_job", "answer_job_ids": [], "non_job_bucket": "overhead", "system_detail": "not_job_related", "system_source": "person", "system_job_ids": [], "system_job_ex": [], "system_non_job_ex": 100}'),
   ('bill unsure on an unplaced bill', b || '{"answer": "unsure", "reason": "several_jobs", "answer_job_ids": [], "system_state": "unplaced", "system_detail": "none", "system_source": "none", "system_job_ids": [], "system_job_ex": []}'),
   ('bill installer_unconfirmed', b || '{"system_state": "partial", "system_detail": "installer_unconfirmed"}'),
   ('bill remainder with a non-job part', b || '{"system_state": "partial", "system_detail": "remainder", "system_source": "mixed", "system_job_ex": [50], "system_non_job_ex": 20}'),
   ('bill on a holding job, answered elsewhere', b || jsonb_build_object('system_job_ids', jsonb_build_array(j1, hold), 'system_job_ex', '[60, 40]'::jsonb, 'system_holding_job_ids', jsonb_build_array(hold))),
   ('message job', m),
   ('message no_job', m || '{"answer": "no_job", "answer_job_ids": []}'),
   ('message unsure', m || '{"answer": "unsure", "reason": "not_enough_evidence", "answer_job_ids": []}'),
   ('message other is unknown', m || '{"system_detail": "other", "system_source": "unknown"}'),
   ('message rules', m || '{"system_detail": "single_open", "system_source": "rules"}'),
   ('story', s),
   ('story nothing to grade', s || '{"money_items": 0, "money_right": 0, "unsafe_lines": 2}')
  ) AS x(label, row_) LOOP
  BEGIN
   EXECUTE grade USING v.row_ || jsonb_build_object('id', gen_random_uuid());
   RAISE EXCEPTION USING ERRCODE = 'P0097', MESSAGE = 'accepted';
  EXCEPTION WHEN SQLSTATE 'P0097' THEN NULL;
   WHEN OTHERS THEN RAISE EXCEPTION 'truth set contract: a well-formed % refused (%)', v.label, SQLERRM;
  END;
 END LOOP;
 -- Refused headers.
 FOR v IN SELECT * FROM (VALUES
   ('a bill under a message set id', h || '{"set_id": "tp19-msg-20310316t040000z-hdr"}', 'context_truth_set_sets_kind'),
   ('a bill with pool_all not pool_rows', h || '{"pool_all": 10}', 'context_truth_set_sets_kind'),
   ('a message pool larger than every item', h || '{"set_id": "tp19-msg-20310316t040000z-hdr", "kind": "message", "pool_rows": 30, "pool_all": 20, "screened": 9, "strata": {"multi_job": {"rows": 1, "drawn": 1}, "single_job": {"rows": 8, "drawn": 1}}}', 'context_truth_set_sets_kind'),
   -- An unknown kind breaks two checks (its strata cannot be well formed either): either may refuse it.
   ('an unknown kind', h || '{"kind": "invoice"}', 'context_truth_set_sets_kind|context_truth_set_sets_draw'),
   ('an unknown purpose', h || '{"purpose": "monthly"}', 'context_truth_set_sets_purpose'),
   ('a stratum of another kind', h || '{"strata": {"biggest": {"rows": 1, "drawn": 1}, "multi_job": {"rows": 8, "drawn": 1}}}', 'context_truth_set_sets_draw'),
   ('strata not adding to the draw', h || '{"strata": {"biggest": {"rows": 1, "drawn": 1}, "random": {"rows": 8, "drawn": 2}}}', 'context_truth_set_sets_draw'),
   ('strata not adding to the pool', h || '{"strata": {"biggest": {"rows": 1, "drawn": 1}, "random": {"rows": 7, "drawn": 1}}}', 'context_truth_set_sets_draw'),
   ('a biggest stratum that is not a census', h || '{"screened": 9, "strata": {"biggest": {"rows": 2, "drawn": 1}, "random": {"rows": 7, "drawn": 1}}}', 'context_truth_set_sets_draw'),
   ('a stratum with a third key', h || '{"strata": {"biggest": {"rows": 1, "drawn": 1, "weight": 1}, "random": {"rows": 8, "drawn": 1}}}', 'context_truth_set_sets_draw'),
   ('a digest that is not a sha256', h || '{"draw_digest": "abc"}', 'context_truth_set_sets_draw'),
   ('an exclusion hash that is not a sha256', h || '{"excl_sha256": "abc"}', 'context_truth_set_sets_draw'),
   ('a grader that is not a name', h || '{"grader": "Grader One"}', 'context_truth_set_sets_grader'),
   ('a grade before its draw', h || '{"graded_at": "2031-03-15T04:00:00Z"}', 'context_truth_set_sets_times'),
   ('a grade dated after it was stored', h || '{"graded_at": "2031-03-18T04:00:00Z"}', 'context_truth_set_sets_times')
  ) AS x(label, row_, con) LOOP
  BEGIN
   EXECUTE sets USING v.row_;
   RAISE EXCEPTION USING ERRCODE = 'P0097', MESSAGE = 'accepted';
  EXCEPTION WHEN SQLSTATE 'P0097' THEN RAISE EXCEPTION 'truth set contract: header % was accepted', v.label;
   WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, got = CONSTRAINT_NAME;
    IF st <> '23514' OR got IS NULL OR NOT got = ANY (string_to_array(v.con, '|')) THEN
     RAISE EXCEPTION 'truth set contract: header % refused by % (%) not %', v.label, got, st, v.con;
    END IF;
  END;
 END LOOP;
 BEGIN
  EXECUTE sets USING h;
  RAISE EXCEPTION USING ERRCODE = 'P0097', MESSAGE = 'accepted';
 EXCEPTION WHEN SQLSTATE 'P0097' THEN NULL;
  WHEN OTHERS THEN RAISE EXCEPTION 'truth set contract: a well-formed header refused (%)', SQLERRM;
 END;
 -- One position once, one item once per set.
 EXECUTE grade USING b || jsonb_build_object('id', gen_random_uuid());
 EXECUTE grade USING m || jsonb_build_object('id', gen_random_uuid());
 EXECUTE grade USING s || jsonb_build_object('id', gen_random_uuid());
 FOR v IN SELECT * FROM (VALUES
   ('a bill position twice', b || '{"xero_invoice_id": "bill-y"}', 'context_truth_set_grades_pos_once'),
   ('a bill twice', b || '{"pos": 2}', 'context_truth_set_grades_bill_once'),
   ('a message twice', m || '{"pos": 2}', 'context_truth_set_grades_msg_once'),
   ('a story twice', s || '{"pos": 2, "story_text_id": "a3100000-0000-4000-8005-000000000002"}', 'context_truth_set_grades_story_once')
  ) AS x(label, row_, con) LOOP
  BEGIN
   EXECUTE grade USING v.row_ || jsonb_build_object('id', gen_random_uuid());
   RAISE EXCEPTION 'truth set contract: % was accepted', v.label;
  EXCEPTION WHEN unique_violation THEN
   GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
   IF got IS DISTINCT FROM v.con THEN RAISE EXCEPTION 'truth set contract: % refused by % not %', v.label, got, v.con; END IF;
  END;
 END LOOP;
END $$;
ROLLBACK;

-- 5. The results, read by hand. Bill set B (first): 2 of the 2 biggest (weight 1) and 3 of 10 random (weight 10/3).
--  pos 1 biggest 8000 balanced ai     [J1 8000]            person: job J1                       right 8000
--  pos 2 biggest 6000 balanced rules  [J1 3000, J2 3000]   person: split J1 3000, J2 2000, stock right 5000
--  pos 3 random   100 balanced ai     [J2 100]             person: job J3                       right 0
--  pos 4 random    50 none            (unplaced)           person: job J1                       placed 0
--  pos 5 random   200 balanced person [J3 200]             person: job J3                       right 200
-- Bill set H (first, older): 3 random of 3, all ai; two touch a holding job, one awaits its installer.
--  pos 1 random 100 balanced [J1 60, HOLD 40]      person: job J1   right 60, not right
--  pos 2 random 100 balanced [J1 100, HOLD 0.01]   person: job J1   right 100 dollars, but never right (a holding job)
--  pos 3 random 100 installer_unconfirmed [J2 100] person: job J2   not placed: counts no dollar and no item
-- Message set M (first): pool 40 placed of 50; 2 of 5 multi-job (weight 2.5), 2 of 15 single-job (weight 7.5).
--  pos 1 multi  luna (ai)          J1    person: J1      right
--  pos 2 multi  single_open        J2    person: J1      wrong
--  pos 3 single luna (ai)          J3    person: unsure
--  pos 4 single payload_job        HOLD  person: no_job  wrong (a holding job)
-- Story set S (first): 2 of 10 finished (weight 5), 1 of 3 in work (weight 3).
--  pos 1 finished 4 shown 4 right 0 unsafe; pos 2 finished 2 shown 1 right 1 unsafe; pos 3 in work 3 shown 0 right.
-- Weekly bill sets P1, P2 and P3 (same header as B) are graded in part: P1 only the biggest, P2 half of each
-- stratum, P3 as many rows as the draw but not the strata the header holds. All three read incomplete, every measure
-- null; P3 is the newest weekly bill set.
BEGIN;
INSERT INTO public.context_truth_set_sets (set_id, kind, purpose, as_of, drawn, draw_digest, pool_rows, pool_all, screened, excl_count,
 excl_sha256, strata, grader, graded_at, created_at)
SELECT v.sid, v.kind, v.purpose, v.as_of::timestamptz, v.drawn, repeat(v.dg, 64), v.pr, v.pa, v.sc, 0, repeat('e', 64), v.strata::jsonb,
 'grader-1', v.as_of::timestamptz + interval '1 day', v.as_of::timestamptz + interval '1 day'
FROM (VALUES
 ('tp19-bill-20310315t040000z-results-b', 'bill', 'first', '2031-03-15 04:00Z', 5, 'b', 12, 12, 12, '{"biggest": {"rows": 2, "drawn": 2}, "random": {"rows": 10, "drawn": 3}}'),
 ('tp19-bill-20310310t040000z-results-h', 'bill', 'first', '2031-03-10 04:00Z', 3, 'c', 3, 3, 3, '{"random": {"rows": 3, "drawn": 3}}'),
 ('tp19-msg-20310315t040000z-results-m', 'message', 'first', '2031-03-15 04:00Z', 4, 'd', 40, 50, 20, '{"multi_job": {"rows": 5, "drawn": 2}, "single_job": {"rows": 15, "drawn": 2}}'),
 ('tp19-story-20310315t040000z-results-s', 'story', 'first', '2031-03-15 04:00Z', 3, 'a', 13, 13, 13, '{"finished": {"rows": 10, "drawn": 2}, "in_work": {"rows": 3, "drawn": 1}}'),
 ('tp19-bill-20310322t040000z-results-p1', 'bill', 'weekly', '2031-03-22 04:00Z', 5, '1', 12, 12, 12, '{"biggest": {"rows": 2, "drawn": 2}, "random": {"rows": 10, "drawn": 3}}'),
 ('tp19-bill-20310329t040000z-results-p2', 'bill', 'weekly', '2031-03-29 04:00Z', 5, '2', 12, 12, 12, '{"biggest": {"rows": 2, "drawn": 2}, "random": {"rows": 10, "drawn": 3}}'),
 ('tp19-bill-20310405t040000z-results-p3', 'bill', 'weekly', '2031-04-05 04:00Z', 5, '3', 12, 12, 12, '{"biggest": {"rows": 2, "drawn": 2}, "random": {"rows": 10, "drawn": 3}}')
) AS v(sid, kind, purpose, as_of, drawn, dg, pr, pa, sc, strata);
WITH hdr AS (SELECT * FROM public.context_truth_set_sets WHERE set_id LIKE '%-results-%'),
rows_ AS (
 SELECT * FROM (VALUES
  -- B
  ('b', 1, 'biggest', 8000.00, 'balanced', 'ai', '{J1}', '{8000}', 0, '{}', 'job', '{J1}', '{}', NULL),
  ('b', 2, 'biggest', 6000.00, 'balanced', 'rules', '{J1,J2}', '{3000,3000}', 0, '{}', 'split', '{J1,J2}', '{3000,2000}', 'stock'),
  ('b', 3, 'random', 100.00, 'balanced', 'ai', '{J2}', '{100}', 0, '{}', 'job', '{J3}', '{}', NULL),
  ('b', 4, 'random', 50.00, 'none', 'none', '{}', '{}', 0, '{}', 'job', '{J1}', '{}', NULL),
  ('b', 5, 'random', 200.00, 'balanced', 'person', '{J3}', '{200}', 0, '{}', 'job', '{J3}', '{}', NULL),
  -- H
  ('h', 1, 'random', 100.00, 'balanced', 'ai', '{J1,HOLD}', '{60,40}', 0, '{HOLD}', 'job', '{J1}', '{}', NULL),
  ('h', 2, 'random', 100.00, 'balanced', 'ai', '{J1,HOLD}', '{100,0.01}', 0, '{HOLD}', 'job', '{J1}', '{}', NULL),
  ('h', 3, 'random', 100.00, 'installer_unconfirmed', 'ai', '{J2}', '{100}', 0, '{}', 'job', '{J2}', '{}', NULL),
  -- P1: only the biggest.
  ('p1', 1, 'biggest', 8000.00, 'balanced', 'ai', '{J1}', '{8000}', 0, '{}', 'job', '{J1}', '{}', NULL),
  ('p1', 2, 'biggest', 6000.00, 'balanced', 'rules', '{J1}', '{6000}', 0, '{}', 'job', '{J1}', '{}', NULL),
  -- P2: one biggest of 2, two random of 3.
  ('p2', 1, 'biggest', 8000.00, 'balanced', 'ai', '{J1}', '{8000}', 0, '{}', 'job', '{J1}', '{}', NULL),
  ('p2', 3, 'random', 100.00, 'balanced', 'ai', '{J2}', '{100}', 0, '{}', 'job', '{J2}', '{}', NULL),
  ('p2', 4, 'random', 50.00, 'balanced', 'ai', '{J2}', '{50}', 0, '{}', 'job', '{J2}', '{}', NULL),
  -- P3: five rows for a draw of five, but one biggest and four random where the header holds two and three.
  ('p3', 1, 'biggest', 8000.00, 'balanced', 'ai', '{J1}', '{8000}', 0, '{}', 'job', '{J1}', '{}', NULL),
  ('p3', 2, 'random', 100.00, 'balanced', 'ai', '{J1}', '{100}', 0, '{}', 'job', '{J1}', '{}', NULL),
  ('p3', 3, 'random', 100.00, 'balanced', 'ai', '{J2}', '{100}', 0, '{}', 'job', '{J2}', '{}', NULL),
  ('p3', 4, 'random', 50.00, 'balanced', 'ai', '{J2}', '{50}', 0, '{}', 'job', '{J2}', '{}', NULL),
  ('p3', 5, 'random', 50.00, 'balanced', 'ai', '{J3}', '{50}', 0, '{}', 'job', '{J3}', '{}', NULL)
 ) AS r(tag, pos, st, ex, det, src, sj, sx, snj, sh, ans, aj, ax, bucket)
), jobs_(k, id) AS (VALUES ('J1', 'a3100000-0000-4000-8000-000000000001'), ('J2', 'a3100000-0000-4000-8000-000000000002'),
                           ('J3', 'a3100000-0000-4000-8000-000000000003'), ('HOLD', 'a3100000-0000-4000-8000-000000000009'))
INSERT INTO public.context_truth_set_grades (set_id, kind, purpose, as_of, drawn, draw_digest, pos, stratum, xero_invoice_id, amount_ex,
 system_state, system_detail, system_source, system_job_ids, system_job_ex, system_non_job_ex, system_holding_job_ids, answer,
 answer_job_ids, answer_job_ex, non_job_bucket, created_at)
SELECT h.set_id, h.kind, h.purpose, h.as_of, h.drawn, h.draw_digest, r.pos, r.st, 'bill-' || r.tag || '-' || r.pos, r.ex,
 CASE r.det WHEN 'none' THEN 'unplaced' WHEN 'installer_unconfirmed' THEN 'partial' ELSE 'placed' END, r.det, r.src,
 coalesce((SELECT array_agg(j.id::uuid ORDER BY o) FROM unnest(r.sj::text[]) WITH ORDINALITY u(k, o) JOIN jobs_ j ON j.k = u.k), '{}'),
 r.sx::numeric[], r.snj, coalesce((SELECT array_agg(j.id::uuid ORDER BY o) FROM unnest(r.sh::text[]) WITH ORDINALITY u(k, o) JOIN jobs_ j ON j.k = u.k), '{}'),
 r.ans, coalesce((SELECT array_agg(j.id::uuid ORDER BY o) FROM unnest(r.aj::text[]) WITH ORDINALITY u(k, o) JOIN jobs_ j ON j.k = u.k), '{}'),
 r.ax::numeric[], r.bucket, h.created_at
FROM rows_ r JOIN hdr h ON h.set_id LIKE '%-results-' || r.tag;
INSERT INTO public.context_truth_set_grades (set_id, kind, purpose, as_of, drawn, draw_digest, pos, stratum, event_id, system_state,
 system_detail, system_source, system_job_ids, system_holding_job_ids, answer, reason, answer_job_ids, created_at)
SELECT h.set_id, h.kind, h.purpose, h.as_of, h.drawn, h.draw_digest, v.pos, v.st, ('a3100000-0000-4000-800e-00000000000' || v.pos)::uuid,
 'placed', v.det, v.src, ARRAY[v.sj::uuid], v.sh::uuid[], v.ans, v.reason, v.aj::uuid[], h.created_at
FROM public.context_truth_set_sets h, (VALUES
 (1, 'multi_job', 'luna', 'ai', 'a3100000-0000-4000-8000-000000000001', '{}', 'job', NULL, '{a3100000-0000-4000-8000-000000000001}'),
 (2, 'multi_job', 'single_open', 'rules', 'a3100000-0000-4000-8000-000000000002', '{}', 'job', NULL, '{a3100000-0000-4000-8000-000000000001}'),
 (3, 'single_job', 'luna', 'ai', 'a3100000-0000-4000-8000-000000000003', '{}', 'unsure', 'several_jobs', '{}'),
 (4, 'single_job', 'payload_job', 'rules', 'a3100000-0000-4000-8000-000000000009', '{a3100000-0000-4000-8000-000000000009}', 'no_job', NULL, '{}')
) AS v(pos, st, det, src, sj, sh, ans, reason, aj)
WHERE h.set_id = 'tp19-msg-20310315t040000z-results-m';
INSERT INTO public.context_truth_set_grades (set_id, kind, purpose, as_of, drawn, draw_digest, pos, stratum, job_id, story_text_id,
 generation_id, system_state, system_detail, system_source, system_job_ids, answer, money_items, money_right, unsafe_lines, created_at)
SELECT h.set_id, h.kind, h.purpose, h.as_of, h.drawn, h.draw_digest, v.pos, v.st, v.j::uuid, ('a3100000-0000-4000-8005-00000000000' || v.pos)::uuid,
 NULL, 'story', 'written', 'ai', ARRAY[v.j::uuid], 'graded', v.mi, v.mr, v.ul, h.created_at
FROM public.context_truth_set_sets h, (VALUES
 (1, 'finished', 'a3100000-0000-4000-8000-000000000001', 4, 4, 0),
 (2, 'finished', 'a3100000-0000-4000-8000-000000000002', 2, 1, 1),
 (3, 'in_work', 'a3100000-0000-4000-8000-000000000003', 3, 0, 0)
) AS v(pos, st, j, mi, mr, ul)
WHERE h.set_id = 'tp19-story-20310315t040000z-results-s';
DO $$
DECLARE b record; hh record; m record; s record; p1 record; p2 record; p3 record; want jsonb;
BEGIN
 SELECT * INTO b FROM public.context_truth_set_results('2031-04-10 00:00Z') r WHERE r.set_id = 'tp19-bill-20310315t040000z-results-b';
 SELECT * INTO hh FROM public.context_truth_set_results('2031-04-10 00:00Z') r WHERE r.set_id = 'tp19-bill-20310310t040000z-results-h';
 SELECT * INTO m FROM public.context_truth_set_results('2031-04-10 00:00Z') r WHERE r.set_id = 'tp19-msg-20310315t040000z-results-m';
 SELECT * INTO s FROM public.context_truth_set_results('2031-04-10 00:00Z') r WHERE r.set_id = 'tp19-story-20310315t040000z-results-s';
 SELECT * INTO p1 FROM public.context_truth_set_results('2031-04-10 00:00Z') r WHERE r.set_id = 'tp19-bill-20310322t040000z-results-p1';
 SELECT * INTO p2 FROM public.context_truth_set_results('2031-04-10 00:00Z') r WHERE r.set_id = 'tp19-bill-20310329t040000z-results-p2';
 SELECT * INTO p3 FROM public.context_truth_set_results('2031-04-10 00:00Z') r WHERE r.set_id = 'tp19-bill-20310405t040000z-results-p3';
 IF NOT (b.complete AND b.graded = 5 AND b.newest AND hh.complete AND NOT hh.newest AND m.complete AND m.newest AND s.complete AND s.newest) THEN
  RAISE EXCEPTION 'truth set contract: complete or newest wrong (B % % %, H % %, M % %, S % %)', b.complete, b.graded, b.newest,
   hh.complete, hh.newest, m.complete, m.newest, s.complete, s.newest;
 END IF;
 -- Bills, weighted (biggest 1, random 10/3). ai dollars (8000 + 0) / (8000 + 100 x 10/3) = 0.96; rules 5000 / 6000;
 -- placed dollars (14000 + 300 x 10/3) / (14000 + 350 x 10/3) = 0.98901; placed count (2 + 2 x 10/3) / 12;
 -- automated dollars (rules, ai, none; no person) 13000 / (14000 + 100 x 10/3); automated count 1 / (2 + 10/3);
 -- ai count 1 / (1 + 10/3); over 5000 automated 13000 / 14000. The person's own placement (pos 5) only in its own share.
 want := '{"ai_right_of_placed_dollars_weighted": 0.9600, "ai_over_5000_right_of_placed_dollars_weighted": 1.0000,
           "rules_right_of_placed_dollars_weighted": 0.8333}';
 IF b.measures -> 'against_08_bar' IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'truth set contract: bill against_08_bar %, want %', b.measures -> 'against_08_bar', want;
 END IF;
 want := '{"placed_share_dollars_weighted": 0.9890, "placed_share_count_weighted": 0.7222,
           "automated_right_of_placed_dollars_weighted": 0.9069, "automated_right_of_placed_count_weighted": 0.1875,
           "automated_over_5000_right_of_placed_dollars_weighted": 0.9285, "ai_right_of_placed_count_weighted": 0.2307,
           "rules_right_of_placed_count_weighted": 0.0000, "mixed_right_of_placed_dollars_weighted": null,
           "unknown_right_of_placed_dollars_weighted": null,
           "person_placed_right_of_placed_dollars_weighted_excluded_from_every_share_above": 1.0000,
           "person_placed_right_of_placed_count_weighted_excluded_from_every_share_above": 1.0000}';
 IF b.measures -> 'not_against_a_bar' IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'truth set contract: bill not_against_a_bar %, want %', b.measures -> 'not_against_a_bar', want;
 END IF;
 IF b.measures #> '{strata_unweighted,random}' IS DISTINCT FROM '{"stratum_rows": 10, "drawn": 3, "graded": 3, "weight": 3.3333,
     "placed": 2, "right": 1, "unsure": 0, "person_placed": 1, "installer_unconfirmed": 0, "on_holding_job": 0, "drawn_ex": 350.00,
     "placed_ex": 300.00, "right_ex": 200.00, "money_items": 0, "money_right": 0, "unsafe_lines": 0}'::jsonb THEN
  RAISE EXCEPTION 'truth set contract: bill random stratum counts %', b.measures #> '{strata_unweighted,random}';
 END IF;
 -- A holding job is never right: H's dollars on J1 count (160 of 200), but neither bill is right by count, even the
 -- one whose every job dollar matched. The bill awaiting its installer is not placed: no dollar, no item.
 IF (hh.measures #>> '{against_08_bar,ai_right_of_placed_dollars_weighted}')::numeric IS DISTINCT FROM 0.8000
  OR (hh.measures #>> '{not_against_a_bar,ai_right_of_placed_count_weighted}')::numeric IS DISTINCT FROM 0.0000
  OR (hh.measures #>> '{strata_unweighted,random,on_holding_job}')::int IS DISTINCT FROM 2
  OR (hh.measures #>> '{strata_unweighted,random,right}')::int IS DISTINCT FROM 0
  OR (hh.measures #>> '{strata_unweighted,random,placed}')::int IS DISTINCT FROM 2
  OR (hh.measures #>> '{strata_unweighted,random,installer_unconfirmed}')::int IS DISTINCT FROM 1
  OR (hh.measures #>> '{not_against_a_bar,placed_share_dollars_weighted}')::numeric IS DISTINCT FROM 0.6666 THEN
  RAISE EXCEPTION 'truth set contract: a bill on a holding job read as right %', hh.measures;
 END IF;
 -- Messages, weighted (multi 2.5, single 7.5): right of placed 2.5 / 20; ai 2.5 / 10; right of all 0.125 x 40 / 50.
 IF m.measures -> 'against_08_bar' IS DISTINCT FROM '{"ai_right_of_placed_weighted": 0.2500}'::jsonb THEN
  RAISE EXCEPTION 'truth set contract: message against_08_bar %', m.measures -> 'against_08_bar';
 END IF;
 want := '{"right_of_placed_weighted": 0.1250, "placed_share": 0.8000, "right_of_all_weighted_row3_style_not_row3": 0.1000,
           "rules_right_of_placed_weighted": 0.0000, "unknown_right_of_placed_weighted": null,
           "multi_job_right_of_placed": 0.5000, "single_job_right_of_placed": 0.0000,
           "ai_multi_job_right_of_placed_not_the_tp21_check_bar": 1.0000, "ai_items": 2}';
 IF m.measures -> 'not_against_a_bar' IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'truth set contract: message not_against_a_bar %, want %', m.measures -> 'not_against_a_bar', want;
 END IF;
 IF (m.measures #>> '{strata_unweighted,single_job,on_holding_job}')::int IS DISTINCT FROM 1
  OR (m.measures #>> '{strata_unweighted,single_job,unsure}')::int IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'truth set contract: message single_job stratum counts %', m.measures #> '{strata_unweighted,single_job}';
 END IF;
 -- Stories, weighted (finished 5, in work 3): money (5 x 5) / (6 x 5 + 3 x 3) = 25 / 39; with unsafe lines 5 / 13.
 IF s.measures -> 'against_08_bar' IS DISTINCT FROM '{"money_items_right_weighted": 0.6410, "unsafe_lines_total": 1}'::jsonb
  OR s.measures -> 'not_against_a_bar' IS DISTINCT FROM '{"stories_with_unsafe_lines_weighted": 0.3846}'::jsonb THEN
  RAISE EXCEPTION 'truth set contract: story measures %', s.measures;
 END IF;
 -- Partial sets: every measure null, and the per-stratum counts still read.
 IF p1.complete OR p1.graded <> 2 OR p1.measures -> 'against_08_bar' <> 'null'::jsonb OR p1.measures -> 'not_against_a_bar' <> 'null'::jsonb
  OR (p1.measures #>> '{strata_unweighted,random,graded}')::int IS DISTINCT FROM 0 THEN
  RAISE EXCEPTION 'truth set contract: a set with a stratum ungraded read measures %', p1.measures;
 END IF;
 IF p2.complete OR p2.graded <> 3 OR p2.measures -> 'against_08_bar' <> 'null'::jsonb OR p2.measures -> 'not_against_a_bar' <> 'null'::jsonb THEN
  RAISE EXCEPTION 'truth set contract: a half-graded set read measures %', p2.measures;
 END IF;
 IF p3.complete OR p3.graded <> 5 OR p3.measures -> 'against_08_bar' <> 'null'::jsonb OR p3.measures -> 'not_against_a_bar' <> 'null'::jsonb THEN
  RAISE EXCEPTION 'truth set contract: a set whose rows do not match its strata read measures %', p3.measures;
 END IF;
 IF p1.newest OR p2.newest OR NOT p3.newest THEN
  RAISE EXCEPTION 'truth set contract: the newest weekly bill set is not P3 (% % %)', p1.newest, p2.newest, p3.newest;
 END IF;
 -- A set is read only once it was created and graded by p_as_of.
 IF EXISTS (SELECT 1 FROM public.context_truth_set_results('2031-03-15 12:00Z') r WHERE r.set_id LIKE '%-results-b')
  OR NOT EXISTS (SELECT 1 FROM public.context_truth_set_results('2031-03-15 12:00Z') r WHERE r.set_id LIKE '%-results-h' AND r.newest) THEN
  RAISE EXCEPTION 'truth set contract: a set graded after p_as_of was read, or the one before it was not';
 END IF;
END $$;
ROLLBACK;
