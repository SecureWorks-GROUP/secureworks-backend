-- Contract for 20261029150000_context_truth_set_grades: the TP-19 truth-set grades table tied to its draw, the
-- draw digest, and the per-set results. Every fixture row is synthetic and rolled back. Every instant is pinned
-- (the sets are drawn as of Sat 15 Mar 2031 04:00Z and created_at is given), so no column default (now()) reaches
-- an assertion.

-- 1. Shape: exact columns, RLS on with no policy, the indexes, this migration's comments, and the grants.
DO $$
DECLARE cols text; f text;
BEGIN
 IF to_regclass('public.context_truth_set_grades') IS NULL THEN RAISE EXCEPTION 'truth set contract: the table is missing'; END IF;
 SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid = 'public.context_truth_set_grades'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
 IF cols IS DISTINCT FROM 'id:uuid,set_id:text,kind:text,purpose:text,as_of:timestamp with time zone,pos:integer,drawn:integer,'
   'draw_digest:text,pool_rows:integer,stratum:text,stratum_rows:integer,stratum_drawn:integer,xero_invoice_id:text,'
   'amount_ex:numeric(12,2),event_id:uuid,system_state:text,system_job_ids:uuid[],system_non_job_part:boolean,'
   'system_source:text,answer:text,reason:text,answer_job_ids:uuid[],non_job_bucket:text,grader:text,'
   'graded_at:timestamp with time zone,created_at:timestamp with time zone' THEN
  RAISE EXCEPTION 'truth set contract: unexpected columns %', cols;
 END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_truth_set_grades'::regclass) THEN
  RAISE EXCEPTION 'truth set contract: row level security is off';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.context_truth_set_grades'::regclass) THEN
  RAISE EXCEPTION 'truth set contract: the table carries a policy';
 END IF;
 IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'context_truth_set_grades'
     AND indexname IN ('context_truth_set_grades_bill_once', 'context_truth_set_grades_msg_once', 'context_truth_set_grades_as_of',
                       'context_truth_set_grades_pos_once')) <> 4 THEN
  RAISE EXCEPTION 'truth set contract: an index is missing';
 END IF;
 IF coalesce(obj_description('public.context_truth_set_grades'::regclass, 'pg_class'), '') NOT LIKE 'Context truth-set grades (20261029150000)%' THEN
  RAISE EXCEPTION 'truth set contract: the table comment does not name the migration';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_truth_set_ids_ok(uuid[])', 'public.context_truth_set_draw_digest(jsonb)',
   'public.context_truth_set_results(timestamptz)'] LOOP
  IF coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '') NOT LIKE 'Context truth-set grades (20261029150000)%' THEN
   RAISE EXCEPTION 'truth set contract: % comment does not name the migration', f;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'truth set contract: % must run for service_role only', f;
  END IF;
 END LOOP;
 IF (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.context_truth_set_draw_digest(jsonb)')) <> 'i'
  OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.context_truth_set_results(timestamptz)')) THEN
  RAISE EXCEPTION 'truth set contract: the digest must be IMMUTABLE and the results SECURITY DEFINER';
 END IF;
 IF has_table_privilege('anon', 'public.context_truth_set_grades', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR has_table_privilege('authenticated', 'public.context_truth_set_grades', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
  RAISE EXCEPTION 'truth set contract: anon or authenticated holds a privilege on the table';
 END IF;
 IF NOT has_table_privilege('service_role', 'public.context_truth_set_grades', 'SELECT')
  OR NOT has_table_privilege('service_role', 'public.context_truth_set_grades', 'INSERT')
  OR has_table_privilege('service_role', 'public.context_truth_set_grades', 'UPDATE,DELETE,TRUNCATE') THEN
  RAISE EXCEPTION 'truth set contract: service_role must hold SELECT and INSERT only';
 END IF;
END $$;

-- 2. The digest: the value the draw scripts and tp19_sheets.py compute (a sha256 pinned here), row order does
-- not matter, any edit moves it, and a mixed, short-fielded or empty draw has none.
DO $$
DECLARE
 d jsonb := '[{"set_id": "tp19-bill-20310315t040000z-b1r1-d180-00000000000000aa", "kind": "bill", "as_of_utc": "2031-03-15T04:00:00Z", "drawn": "2", "pool_rows": "9", "screened": "9", "excl_count": "0", "pos": "1", "item_id": "bill-a", "stratum": "biggest", "stratum_rows": "1", "stratum_drawn": "1", "amount_ex": "6000.00", "system_state": "job", "system_job_ids": "a3100000-0000-4000-8000-000000000001", "system_non_job_part": "false", "system_source": "rules"}, {"set_id": "tp19-bill-20310315t040000z-b1r1-d180-00000000000000aa", "kind": "bill", "as_of_utc": "2031-03-15T04:00:00Z", "drawn": "2", "pool_rows": "9", "screened": "9", "excl_count": "0", "pos": "2", "item_id": "bill-b", "stratum": "random", "stratum_rows": "8", "stratum_drawn": "1", "amount_ex": "100.50", "system_state": "unplaced", "system_job_ids": "", "system_non_job_part": "false", "system_source": "none"}]';
 want constant text := 'e40a4c0e2fd6c114d960524f7739c4a2bc27c7ec1dbade723935af6aa75c37eb';
BEGIN
 IF public.context_truth_set_draw_digest(d) IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'truth set contract: the digest is % not %', public.context_truth_set_draw_digest(d), want;
 END IF;
 IF public.context_truth_set_draw_digest(jsonb_build_array(d -> 1, d -> 0)) IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'truth set contract: the digest depends on the order the rows were saved in';
 END IF;
 IF public.context_truth_set_draw_digest(jsonb_set(d, '{1,amount_ex}', '"100.51"')) = want
  OR public.context_truth_set_draw_digest(jsonb_set(d, '{0,system_state}', '"split"')) = want
  OR public.context_truth_set_draw_digest(jsonb_build_array(d -> 0)) = want THEN
  RAISE EXCEPTION 'truth set contract: an edited or short draw keeps the digest';
 END IF;
 IF public.context_truth_set_draw_digest(jsonb_set(d, '{1,set_id}', '"tp19-bill-20310315t040000z-other"')) IS NOT NULL
  OR public.context_truth_set_draw_digest(d #- '{1,system_source}') IS NOT NULL
  OR public.context_truth_set_draw_digest('[]') IS NOT NULL OR public.context_truth_set_draw_digest('{}') IS NOT NULL THEN
  RAISE EXCEPTION 'truth set contract: a mixed, short-fielded or empty draw has a digest';
 END IF;
END $$;

-- 3. The checks: every malformed row refuses, by its own constraint.
BEGIN;
CREATE TEMP TABLE tsg_fixture AS SELECT * FROM public.context_truth_set_grades WHERE false;
DO $$
DECLARE
 j1 constant text := 'a3100000-0000-4000-8000-000000000001'; j2 constant text := 'a3100000-0000-4000-8000-000000000002';
 bill constant text := 'INSERT INTO public.context_truth_set_grades (set_id, kind, purpose, as_of, pos, drawn, draw_digest, pool_rows, stratum, '
  'stratum_rows, stratum_drawn, xero_invoice_id, amount_ex, event_id, system_state, system_job_ids, system_non_job_part, system_source, answer, '
  'reason, answer_job_ids, non_job_bucket, grader, graded_at, created_at) VALUES (';
 ok_b constant text := '''tp19-bill-20310315t040000z-check'', ''bill'', ''first'', ''2031-03-15 04:00Z'', 1, 5, repeat(''a'', 64), 9, ''random'', 8, 4, ''bill-x'', 10, NULL, ';
 ok_m constant text := '''tp19-msg-20310315t040000z-check'', ''message'', ''first'', ''2031-03-15 04:00Z'', 1, 5, repeat(''a'', 64), 9, ''multi_job'', 8, 4, NULL, NULL, ''a3100000-0000-4000-800e-000000000001'', ';
 tail constant text := ', ''grader-1'', ''2031-03-16 04:00Z'', ''2031-03-16 04:00Z'')';
 bad record; good text; got text;
BEGIN
 -- Accepted shapes (each in a subtransaction, so the next one starts clean).
 FOREACH good IN ARRAY ARRAY[
   ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''job'', NULL, ARRAY[''' || j1 || ''']::uuid[], NULL',
   ok_b || '''split'', ARRAY[''' || j1 || ''']::uuid[], true, ''mixed'', ''split'', NULL, ARRAY[''' || j1 || ''']::uuid[], ''stock''',
   ok_b || '''non_job'', ''{}'', true, ''ai'', ''non_job'', NULL, ''{}'', ''overhead''',
   ok_b || '''unplaced'', ''{}'', false, ''none'', ''unsure'', ''several_jobs'', ''{}'', NULL',
   ok_m || '''placed'', ARRAY[''' || j1 || ''']::uuid[], false, ''none'', ''right'', NULL, ''{}'', NULL',
   ok_m || '''placed'', ARRAY[''' || j1 || ''']::uuid[], false, ''none'', ''wrong'', ''other_job'', ARRAY[''' || j2 || ''']::uuid[], NULL',
   ok_m || '''placed'', ARRAY[''' || j1 || ''']::uuid[], false, ''none'', ''wrong'', ''no_job'', ''{}'', NULL',
   ok_m || '''placed'', ARRAY[''' || j1 || ''']::uuid[], false, ''none'', ''unsure'', ''not_enough_evidence'', ''{}'', NULL'] LOOP
  BEGIN
   EXECUTE bill || good || tail;
   RAISE EXCEPTION USING ERRCODE = 'P0097', MESSAGE = 'accepted';
  EXCEPTION WHEN SQLSTATE 'P0097' THEN NULL;
   WHEN OTHERS THEN RAISE EXCEPTION 'truth set contract: a well-formed row refused (%): %', SQLERRM, good;
  END;
 END LOOP;
 -- Refused shapes, each naming the constraint that must refuse it.
 FOR bad IN SELECT * FROM (VALUES
   ('bill job with no job', ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''job'', NULL, ''{}'', NULL', 'context_truth_set_grades_answer'),
   ('bill split with one job and no bucket', ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''split'', NULL, ARRAY[''' || j1 || ''']::uuid[], NULL', 'context_truth_set_grades_answer'),
   ('bill with no Xero id', replace(ok_b, '''bill-x''', 'NULL') || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''job'', NULL, ARRAY[''' || j1 || ''']::uuid[], NULL', 'context_truth_set_grades_kind'),
   ('bill unsure with no reason', ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''unsure'', NULL, ''{}'', NULL', 'context_truth_set_grades_answer'),
   ('bill non_job with no bucket', ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''non_job'', NULL, ''{}'', NULL', 'context_truth_set_grades_answer'),
   ('bill unknown bucket', ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''non_job'', NULL, ''{}'', ''lunch''', 'context_truth_set_grades_answer'),
   ('bill unknown answer', ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''maybe'', NULL, ''{}'', NULL', 'context_truth_set_grades_answer'),
   ('bill a job twice', ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''split'', NULL, ARRAY[''' || j1 || ''', ''' || j1 || ''']::uuid[], NULL', 'context_truth_set_grades_jobs_distinct'),
   ('bill system job state with no job', ok_b || '''job'', ''{}'', false, ''rules'', ''unsure'', ''several_jobs'', ''{}'', NULL', 'context_truth_set_grades_kind'),
   ('bill unplaced with a source', ok_b || '''unplaced'', ''{}'', false, ''ai'', ''unsure'', ''several_jobs'', ''{}'', NULL', 'context_truth_set_grades_kind'),
   ('message wrong other_job naming the placed job', ok_m || '''placed'', ARRAY[''' || j1 || ''']::uuid[], false, ''none'', ''wrong'', ''other_job'', ARRAY[''' || j1 || ''']::uuid[], NULL', 'context_truth_set_grades_answer'),
   ('message wrong with no reason', ok_m || '''placed'', ARRAY[''' || j1 || ''']::uuid[], false, ''none'', ''wrong'', NULL, ''{}'', NULL', 'context_truth_set_grades_answer'),
   ('message right with a job', ok_m || '''placed'', ARRAY[''' || j1 || ''']::uuid[], false, ''none'', ''right'', NULL, ARRAY[''' || j2 || ''']::uuid[], NULL', 'context_truth_set_grades_answer'),
   ('message with a bucket', ok_m || '''placed'', ARRAY[''' || j1 || ''']::uuid[], false, ''none'', ''right'', NULL, ''{}'', ''stock''', 'context_truth_set_grades_answer'),
   ('message on no job', ok_m || '''placed'', ''{}'', false, ''none'', ''right'', NULL, ''{}'', NULL', 'context_truth_set_grades_kind')
  ) AS v(label, sql, con) LOOP
  BEGIN
   EXECUTE bill || bad.sql || tail;
   RAISE EXCEPTION 'truth set contract: % was accepted', bad.label;
  EXCEPTION WHEN check_violation THEN
   GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
   IF got IS DISTINCT FROM bad.con THEN RAISE EXCEPTION 'truth set contract: % refused by % not %', bad.label, got, bad.con; END IF;
  END;
 END LOOP;
 -- The draw, the purpose, the set id, the grader and the times.
 FOR bad IN SELECT * FROM (VALUES
   ('a position past the draw', replace(ok_b, ', 1, 5, repeat', ', 6, 5, repeat'), 'context_truth_set_grades_draw'),
   ('a stratum larger than the pool', replace(ok_b, '9, ''random'', 8, 4', '9, ''random'', 10, 4'), 'context_truth_set_grades_draw'),
   ('a digest that is not a sha256', replace(ok_b, 'repeat(''a'', 64)', '''abc'''), 'context_truth_set_grades_draw'),
   ('an unknown purpose', replace(ok_b, '''first''', '''monthly'''), 'context_truth_set_grades_purpose'),
   ('a bill under a message set id', replace(ok_b, 'tp19-bill-', 'tp19-msg-'), 'context_truth_set_grades_kind'),
   ('a bill in a message stratum', replace(ok_b, '''random''', '''multi_job'''), 'context_truth_set_grades_kind')
  ) AS v(label, sql, con) LOOP
  BEGIN
   EXECUTE bill || bad.sql || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''job'', NULL, ARRAY[''' || j1 || ''']::uuid[], NULL' || tail;
   RAISE EXCEPTION 'truth set contract: % was accepted', bad.label;
  EXCEPTION WHEN check_violation THEN
   GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
   IF got IS DISTINCT FROM bad.con THEN RAISE EXCEPTION 'truth set contract: % refused by % not %', bad.label, got, bad.con; END IF;
  END;
 END LOOP;
 BEGIN
  EXECUTE bill || ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''job'', NULL, ARRAY[''' || j1 || ''']::uuid[], NULL'
   || ', ''Grader One'', ''2031-03-16 04:00Z'', ''2031-03-16 04:00Z'')';
  RAISE EXCEPTION 'truth set contract: a grader that is not a name was accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  EXECUTE bill || ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''job'', NULL, ARRAY[''' || j1 || ''']::uuid[], NULL'
   || ', ''grader-1'', ''2031-03-14 04:00Z'', ''2031-03-16 04:00Z'')';
  RAISE EXCEPTION 'truth set contract: a grade before its draw was accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 -- One position once, one item once.
 EXECUTE bill || ok_b || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''job'', NULL, ARRAY[''' || j1 || ''']::uuid[], NULL' || tail;
 BEGIN
  EXECUTE bill || ok_b || '''job'', ARRAY[''' || j2 || ''']::uuid[], false, ''rules'', ''job'', NULL, ARRAY[''' || j2 || ''']::uuid[], NULL' || tail;
  RAISE EXCEPTION 'truth set contract: a position loaded twice';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 BEGIN
  EXECUTE bill || replace(ok_b, ', 1, 5, repeat', ', 2, 5, repeat') || '''job'', ARRAY[''' || j1 || ''']::uuid[], false, ''rules'', ''job'', NULL, ARRAY[''' || j1 || ''']::uuid[], NULL' || tail;
  RAISE EXCEPTION 'truth set contract: a bill loaded twice in one set';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
END $$;
ROLLBACK;

-- 4. The results: a bill set and a message set with every outcome, read by hand.
BEGIN;
INSERT INTO public.context_truth_set_grades (set_id, kind, purpose, as_of, pos, drawn, draw_digest, pool_rows, stratum, stratum_rows,
 stratum_drawn, xero_invoice_id, amount_ex, system_state, system_job_ids, system_non_job_part, system_source, answer, reason,
 answer_job_ids, non_job_bucket, grader, graded_at, created_at)
SELECT 'tp19-bill-20310315t040000z-results', 'bill', 'first', '2031-03-15 04:00Z', v.pos, 6, repeat('b', 64), 12, v.st,
 CASE v.st WHEN 'biggest' THEN 2 ELSE 10 END, CASE v.st WHEN 'biggest' THEN 2 ELSE 4 END, 'bill-' || v.pos, v.ex, v.ss, v.sj::uuid[],
 v.snp, v.src, v.ans, NULL, v.aj::uuid[], v.b, 'grader-1', '2031-03-16 04:00Z', '2031-03-16 04:00Z'
FROM (VALUES
 (1, 'biggest', 6000.00, 'job', '{a3100000-0000-4000-8000-000000000001}', false, 'rules', 'job', '{a3100000-0000-4000-8000-000000000001}', NULL),
 (2, 'biggest', 5500.00, 'job', '{a3100000-0000-4000-8000-000000000001}', false, 'ai', 'job', '{a3100000-0000-4000-8000-000000000002}', NULL),
 (3, 'random', 100.00, 'split', '{a3100000-0000-4000-8000-000000000001,a3100000-0000-4000-8000-000000000002}', false, 'person', 'split',
  '{a3100000-0000-4000-8000-000000000002,a3100000-0000-4000-8000-000000000001}', NULL),
 (4, 'random', 200.00, 'non_job', '{}', true, 'ai', 'non_job', '{}', 'overhead'),
 (5, 'random', 300.00, 'unplaced', '{}', false, 'none', 'job', '{a3100000-0000-4000-8000-000000000001}', NULL),
 (6, 'random', 400.00, 'split', '{a3100000-0000-4000-8000-000000000001}', true, 'mixed', 'job', '{a3100000-0000-4000-8000-000000000001}', NULL)
) AS v(pos, st, ex, ss, sj, snp, src, ans, aj, b);
-- An older first bill set: never the newest.
INSERT INTO public.context_truth_set_grades (set_id, kind, purpose, as_of, pos, drawn, draw_digest, pool_rows, stratum, stratum_rows,
 stratum_drawn, xero_invoice_id, amount_ex, system_state, system_job_ids, system_non_job_part, system_source, answer, reason,
 answer_job_ids, non_job_bucket, grader, graded_at, created_at)
VALUES ('tp19-bill-20310301t040000z-older', 'bill', 'first', '2031-03-01 04:00Z', 1, 1, repeat('c', 64), 1, 'random', 1, 1, 'bill-o', 10,
 'unplaced', '{}', false, 'none', 'unsure', 'not_enough_evidence', '{}', NULL, 'grader-1', '2031-03-02 04:00Z', '2031-03-02 04:00Z');
INSERT INTO public.context_truth_set_grades (set_id, kind, purpose, as_of, pos, drawn, draw_digest, pool_rows, stratum, stratum_rows,
 stratum_drawn, event_id, system_state, system_job_ids, system_source, answer, reason, answer_job_ids, grader, graded_at, created_at)
SELECT 'tp19-msg-20310315t040000z-results', 'message', 'weekly', '2031-03-15 04:00Z', v.pos, 4, repeat('d', 64), 200, v.st,
 CASE v.st WHEN 'multi_job' THEN 30 ELSE 70 END, 2, ('a3100000-0000-4000-800e-00000000000' || v.pos)::uuid, 'placed',
 '{a3100000-0000-4000-8000-000000000001}', 'none', v.ans, v.r, v.aj::uuid[], 'grader-2', '2031-03-16 04:00Z', '2031-03-16 04:00Z'
FROM (VALUES (1, 'multi_job', 'wrong', 'other_job', '{a3100000-0000-4000-8000-000000000002}'),
             (2, 'multi_job', 'unsure', 'several_jobs', '{}'),
             (3, 'single_job', 'right', NULL, '{}'),
             (4, 'single_job', 'right', NULL, '{}')) AS v(pos, st, ans, r, aj);
DO $$
DECLARE b record; m record; o record;
BEGIN
 SELECT * INTO b FROM public.context_truth_set_results('2031-03-20 00:00Z') r WHERE r.set_id = 'tp19-bill-20310315t040000z-results';
 SELECT * INTO o FROM public.context_truth_set_results('2031-03-20 00:00Z') r WHERE r.set_id = 'tp19-bill-20310301t040000z-older';
 SELECT * INTO m FROM public.context_truth_set_results('2031-03-20 00:00Z') r WHERE r.set_id = 'tp19-msg-20310315t040000z-results';
 IF b.graded <> 6 OR b.drawn <> 6 OR NOT b.newest OR o.newest OR NOT m.newest THEN
  RAISE EXCEPTION 'truth set contract: sets or newest wrong (bill % newest %, older newest %, message newest %)', b.graded, b.newest, o.newest, m.newest;
 END IF;
 -- Placed 5 of 6; right 3 (1, the split in another order, the non_job); 5 unplaced; 2 and 6 wrong (6: a non-job part on one side).
 IF (b.measures ->> 'placed')::int <> 5 OR (b.measures ->> 'right')::int <> 3 THEN
  RAISE EXCEPTION 'truth set contract: bill placed % right % (want 5 and 3)', b.measures ->> 'placed', b.measures ->> 'right';
 END IF;
 IF (b.measures ->> 'placed_share')::numeric <> 0.8333 OR (b.measures ->> 'placed_share_dollars')::numeric <> 0.9760
  OR (b.measures ->> 'right_of_placed')::numeric <> 0.6000 OR (b.measures ->> 'right_of_placed_dollars')::numeric <> 0.5163
  OR (b.measures -> 'over_5000' ->> 'right_of_placed_dollars')::numeric <> 0.5217 OR (b.measures -> 'over_5000' ->> 'drawn')::int <> 2 THEN
  RAISE EXCEPTION 'truth set contract: bill shares wrong (rounded down expected) %', b.measures;
 END IF;
 IF (b.measures -> 'by_source' -> 'ai' ->> 'placed')::int <> 2 OR (b.measures -> 'by_source' -> 'ai' ->> 'right')::int <> 1
  OR (b.measures -> 'by_source' -> 'ai' ->> 'right_ex')::numeric <> 200 THEN
  RAISE EXCEPTION 'truth set contract: bill by_source wrong %', b.measures -> 'by_source';
 END IF;
 IF (o.measures ->> 'right')::int <> 0 THEN RAISE EXCEPTION 'truth set contract: a person unsure counted as right'; END IF;
 -- Messages: right 2 of 4; weighted (0/2 x 30 + 2/2 x 70) / 100 = 0.70.
 IF (m.measures ->> 'right')::int <> 2 OR (m.measures ->> 'wrong')::int <> 1 OR (m.measures ->> 'unsure')::int <> 1
  OR (m.measures ->> 'right_share')::numeric <> 0.5 OR (m.measures ->> 'weighted_right_share')::numeric <> 0.7 THEN
  RAISE EXCEPTION 'truth set contract: an unsure verdict counted as right, or message shares wrong %', m.measures;
 END IF;
 -- A set is read only once it was created and graded by p_as_of.
 IF EXISTS (SELECT 1 FROM public.context_truth_set_results('2031-03-15 12:00Z') r WHERE r.set_id LIKE '%-results') THEN
  RAISE EXCEPTION 'truth set contract: a set graded after p_as_of was read';
 END IF;
END $$;
ROLLBACK;
