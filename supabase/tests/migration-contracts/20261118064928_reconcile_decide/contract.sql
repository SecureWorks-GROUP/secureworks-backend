BEGIN;
SET LOCAL statement_timeout = '120s';
-- Rule 17: re-apply what this contract asserts.
SELECT to_regclass('public.reconcile_items') IS NULL AS decide_contract_needs_tables \gset
\if :decide_contract_needs_tables
\ir ../20261118060051_reconcile_tables/main_lines_reader.sql
\ir ../../../migrations/20261118060051_reconcile_tables.sql
\endif
\ir ../../../migrations/20261118064828_reconcile_item_raise.sql
\ir ../../../migrations/20261118064928_reconcile_decide.sql

CREATE FUNCTION pg_temp.expect_failure(command text, expected text, code text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $expect$
DECLARE failed boolean := false;
/* block */ BEGIN
 BEGIN EXECUTE command;
 EXCEPTION WHEN OTHERS THEN
  IF position(expected IN SQLERRM) = 0 OR (code IS NOT NULL AND SQLSTATE <> code) THEN RAISE; END IF;
  failed := true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'expected refusal: %', expected; END IF;
END $expect$;

-- Fixtures: org A ...a1, org B ...b1. Roles and job numbers only.
INSERT INTO public.jobs(id, org_id, job_number, type, status) VALUES
 ('32030000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'ZZTEST-3203-A1', 'fencing', 'accepted'),
 ('32030000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'ZZTEST-3203-A2', 'fencing', 'accepted'),
 ('32030000-0000-4000-8000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'ZZTEST-3203-C1', 'fencing', 'accepted'),
 ('32030000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'ZZTEST-3203-B1', 'fencing', 'accepted');
UPDATE public.jobs SET status = 'cancelled' WHERE id = '32030000-0000-4000-8000-0000000000c1';
INSERT INTO public.users(id, org_id, name, role) VALUES
 ('32030000-0000-4000-8000-00000000057a', '00000000-0000-0000-0000-0000000000a1', 'ZZTEST staff', 'ops_manager'),
 ('32030000-0000-4000-8000-00000000077a', '00000000-0000-0000-0000-0000000000a1', 'ZZTEST trade', 'installer'),
 ('32030000-0000-4000-8000-00000000057b', '00000000-0000-0000-0000-0000000000b1', 'ZZTEST other staff', 'ops_manager');
INSERT INTO public.job_cost_lines(org_id, kind, document_kind, document_id, line_key, line_no, lane, amount_ex,
  source_hash, state, needs_reason)
SELECT '00000000-0000-0000-0000-0000000000a1', 'supplier_bill', 'xero_bill', 'ZZTEST-3203-' || d, k, n,
  'materials', amt, 'zz', 'needs_person', 'no_clue'
FROM (VALUES ('PLACE','1',1,2000.00), ('SPLIT','1',1,1000.00), ('OVER','1',1,100.00), ('DIV','1',1,50.00),
  ('DUP','1',1,10.00), ('DUP','2',2,20.00), ('LEAVE','1',1,5.00), ('NOTDUP','1',1,7.00),
  ('CANC','1',1,9.00), ('RETRY','1',1,11.00)) v(d, k, n, amt);

-- One open item per document, raised through the one door.
CREATE FUNCTION pg_temp.item(d text) RETURNS uuid LANGUAGE sql AS $f$
 SELECT public.reconcile_item_raise('bill', 'cost_document', 'xero_bill:ZZTEST-3203-' || d,
  ARRAY['32030000-0000-4000-8000-0000000000a1']::uuid[], '{"outcome":"job","clue_ids":[11,12]}'::jsonb,
  jsonb_build_object('reason', 'one_clue', 'summary', jsonb_build_object('number', d)), 'matcher:v1')
$f$;
CREATE FUNCTION pg_temp.dup_item(d text) RETURNS uuid LANGUAGE sql AS $f$
 SELECT public.reconcile_item_raise('bill', 'cost_document', 'xero_bill:ZZTEST-3203-' || d,
  ARRAY['32030000-0000-4000-8000-0000000000a1']::uuid[], NULL,
  jsonb_build_object('reason', 'possible_duplicate', 'summary', jsonb_build_object('number', d)), 'matcher:v1')
$f$;
CREATE FUNCTION pg_temp.h(i uuid) RETURNS text LANGUAGE sql AS $f$
 SELECT evidence_hash FROM public.reconcile_items WHERE id = i $f$;
CREATE FUNCTION pg_temp.line(d text, k text DEFAULT '1') RETURNS public.job_cost_lines LANGUAGE sql AS $f$
 SELECT * FROM public.job_cost_lines WHERE document_kind = 'xero_bill' AND document_id = 'ZZTEST-3203-' || d
  AND line_key = k $f$;
CREATE FUNCTION pg_temp.decide(i uuid, a text, parts jsonb, note text DEFAULT NULL,
  who uuid DEFAULT '32030000-0000-4000-8000-00000000057a') RETURNS jsonb LANGUAGE sql AS $f$
 SELECT public.reconcile_decide(i, pg_temp.h(i), a, parts, note, true, who) $f$;

-- place: the whole line on the live job, by the person, the item decided.
DO $place$
DECLARE i uuid := pg_temp.item('PLACE'); r jsonb; l public.job_cost_lines; d public.reconcile_decisions; marked boolean;
 page_marks bigint;
/* block */ BEGIN
 IF to_regclass('public.job_change_mark_events') IS NOT NULL THEN
  EXECUTE $q$SELECT count(*) FROM public.job_change_mark_events
   WHERE job_id = '32030000-0000-4000-8000-0000000000a1' AND source = 'person'$q$ INTO page_marks;
 END IF;
 r := pg_temp.decide(i, 'place', '[{"job_id":"32030000-0000-4000-8000-0000000000a1"}]');
 l := pg_temp.line('PLACE');
 IF (SELECT amount_ex FROM public.job_cost_line_parts WHERE line_id = l.id AND target = 'job'
     AND job_id = '32030000-0000-4000-8000-0000000000a1') IS DISTINCT FROM 2000.00
  OR (SELECT count(*) FROM public.job_cost_line_parts WHERE line_id = l.id) <> 1 THEN
  RAISE EXCEPTION 'P2-03.3 place must put the whole line on the job'; END IF;
 SELECT * INTO d FROM public.reconcile_decisions WHERE id = (r ->> 'decision_id')::bigint;
 IF l.state <> 'on_job' OR l.decided_by_kind <> 'person' OR l.decision_id <> d.id OR l.needs_reason IS NOT NULL
  OR d."by" <> 'person:32030000-0000-4000-8000-00000000057a' OR d.action <> 'place' OR NOT d.accepted_suggestion
  OR d.clue_ids <> ARRAY[11,12]::bigint[] OR d.item_id <> i OR d.shown_hash <> pg_temp.h(i)
  OR d.before -> 'lines' -> 0 ->> 'state' <> 'needs_person' OR d.before -> 'item' ->> 'status' <> 'open'
  OR d.before -> 'item' -> 'suggestion' ->> 'outcome' <> 'job'
  OR r ->> 'item_status' <> 'decided' OR r -> 'lines' -> 0 ->> 'state' <> 'on_job'
  OR (SELECT status FROM public.reconcile_items WHERE id = i) <> 'decided'
  OR (SELECT decision_id FROM public.reconcile_items WHERE id = i) <> d.id
  OR (SELECT closed_at FROM public.reconcile_items WHERE id = i) IS NULL THEN
  RAISE EXCEPTION 'P2-03.3 place must record and apply the decision: % %', r, row_to_json(d); END IF;
 IF to_regclass('public.job_profit_dirty') IS NOT NULL THEN
  EXECUTE $q$SELECT EXISTS(SELECT 1 FROM public.job_profit_dirty
   WHERE job_id = '32030000-0000-4000-8000-0000000000a1')$q$ INTO marked;
  IF NOT marked THEN RAISE EXCEPTION 'P2-03.3 a placed job must be marked for Job Profit'; END IF;
 END IF;
 -- The job page mark runs only where main's job pages exist (CI, not the isolated run).
 IF to_regclass('public.job_change_mark_events') IS NOT NULL THEN
  EXECUTE $q$SELECT count(*) - $1 FROM public.job_change_mark_events
   WHERE job_id = '32030000-0000-4000-8000-0000000000a1' AND source = 'person'$q$ INTO page_marks USING page_marks;
  IF page_marks < 1 THEN RAISE EXCEPTION 'P2-03.3 a placed job must be marked for its page'; END IF;
 END IF;
 -- A closed item cannot be decided again.
 PERFORM pg_temp.expect_failure(format($f$SELECT public.reconcile_decide(%L,%L,'overhead',NULL,NULL,false,
  '32030000-0000-4000-8000-00000000057a')$f$, i, pg_temp.h(i)), 'reconcile_item_closed');
END $place$;

-- Who may decide, and on what evidence. Each refusal writes nothing.
CREATE TEMP TABLE decide_before AS SELECT (SELECT count(*) FROM public.reconcile_decisions) n,
 (SELECT to_jsonb(l) FROM public.job_cost_lines l WHERE document_id = 'ZZTEST-3203-RETRY') line;
DO $refusals$
DECLARE i uuid := pg_temp.item('RETRY');
/* block */ BEGIN
 FOR n IN 1..2 LOOP -- a retried refusal refuses the same way
  PERFORM pg_temp.expect_failure(format($f$SELECT public.reconcile_decide(%L,%L,'overhead',NULL,NULL,false,
   '32030000-0000-4000-8000-00000000077a')$f$, i, pg_temp.h(i)), 'reconcile_not_staff', '42501');
 END LOOP;
 PERFORM pg_temp.expect_failure(format($f$SELECT public.reconcile_decide(%L,%L,'overhead',NULL,NULL,false,
  '32030000-0000-4000-8000-00000000057b')$f$, i, pg_temp.h(i)), 'reconcile_not_staff', '42501');
 PERFORM pg_temp.expect_failure(format($f$SELECT public.reconcile_decide(%L,%L,'overhead',NULL,NULL,false,NULL)$f$,
  i, pg_temp.h(i)), 'reconcile_not_staff', '42501');
 PERFORM pg_temp.expect_failure(format($f$SELECT public.reconcile_decide(%L,'stale','overhead',NULL,NULL,false,
  '32030000-0000-4000-8000-00000000057a')$f$, i), 'reconcile_evidence_changed');
 -- The evidence changed under the person (a new suggestion): the old hash is stale.
 PERFORM public.reconcile_item_raise('bill', 'cost_document', 'xero_bill:ZZTEST-3203-RETRY',
  ARRAY['32030000-0000-4000-8000-0000000000a2']::uuid[], '{"outcome":"job"}'::jsonb,
  '{"reason":"one_clue"}'::jsonb, 'matcher:v1');
 PERFORM pg_temp.expect_failure(format($f$SELECT public.reconcile_decide(%L,%L,'overhead',NULL,NULL,false,
  '32030000-0000-4000-8000-00000000057a')$f$, i, md5('zz')), 'reconcile_evidence_changed');
 PERFORM pg_temp.expect_failure(format($f$SELECT public.reconcile_decide(%L,%L,%L,NULL,NULL,false,
  '32030000-0000-4000-8000-00000000057a')$f$, i, pg_temp.h(i), a), 'reconcile_action_unknown')
 FROM unnest(ARRAY['undo', 'message', 'shrug']) a;
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'resolve',NULL,'sorted')$f$, i),
  'reconcile_action_not_for_item');
 -- not_duplicate only answers a duplicate hold: on an ordinary bill it would
 -- close the item with its lines still held.
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'not_duplicate',NULL)$f$, i),
  'reconcile_not_a_duplicate_hold');
 PERFORM pg_temp.expect_failure(format($f$SELECT public.reconcile_decide(%L,%L,'overhead',NULL,NULL,false,
  '32030000-0000-4000-8000-00000000057a')$f$, gen_random_uuid(), 'zz'), 'reconcile_item_unknown');
 -- Placing on a cancelled job, or on another organisation's job.
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'place',%L)$f$, i,
  '[{"job_id":"32030000-0000-4000-8000-0000000000c1"}]'), 'reconcile_job_not_live');
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'place',%L)$f$, i,
  '[{"job_id":"32030000-0000-4000-8000-0000000000b1"}]'), 'reconcile_job_not_live');
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'place',%L)$f$, i, '[{}]'),
  'reconcile_parts_invalid');
END $refusals$;
DO $nothing_written$ /* block */ BEGIN
 IF (SELECT count(*) FROM public.reconcile_decisions) <> (SELECT n FROM decide_before)
 OR (SELECT to_jsonb(l) FROM public.job_cost_lines l WHERE document_id = 'ZZTEST-3203-RETRY')
    IS DISTINCT FROM (SELECT line FROM decide_before) THEN
  RAISE EXCEPTION 'P2-03.3 a refused decision must write nothing'; END IF;
END $nothing_written$;

-- split: the parts of each line must add up to it exactly.
DO $split$
DECLARE i uuid := pg_temp.item('SPLIT'); l public.job_cost_lines; s jsonb;
/* block */ BEGIN
 l := pg_temp.line('SPLIT');
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'split',%L)$f$, i, jsonb_build_array(
  jsonb_build_object('line_id', l.id, 'target', 'job', 'job_id', '32030000-0000-4000-8000-0000000000a1', 'amount_ex', 600),
  jsonb_build_object('line_id', l.id, 'target', 'overhead', 'amount_ex', 300))), 'reconcile_parts_do_not_add_up');
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'split',%L)$f$, i, jsonb_build_array(
  jsonb_build_object('line_id', l.id, 'target', 'division_stock', 'division', 'roofing', 'amount_ex', 1000))),
  'reconcile_division_unknown');
 -- Thirds of a cent, a part of the other sign, and a zero part all refuse.
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'split',%L)$f$, i, jsonb_build_array(
  jsonb_build_object('line_id', l.id, 'target', 'overhead', 'amount_ex', 333.333),
  jsonb_build_object('line_id', l.id, 'target', 'overhead', 'amount_ex', 333.333),
  jsonb_build_object('line_id', l.id, 'target', 'overhead', 'amount_ex', 333.334))), 'reconcile_parts_do_not_add_up');
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'split',%L)$f$, i, jsonb_build_array(
  jsonb_build_object('line_id', l.id, 'target', 'job', 'job_id', '32030000-0000-4000-8000-0000000000a1', 'amount_ex', 1500),
  jsonb_build_object('line_id', l.id, 'target', 'overhead', 'amount_ex', -500))), 'reconcile_parts_do_not_add_up');
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'split',%L)$f$, i, jsonb_build_array(
  jsonb_build_object('line_id', l.id, 'target', 'overhead', 'amount_ex', 1000),
  jsonb_build_object('line_id', l.id, 'target', 'overhead', 'amount_ex', 0))), 'reconcile_parts_do_not_add_up');
 s := jsonb_build_array(
  jsonb_build_object('line_id', l.id, 'target', 'job', 'job_id', '32030000-0000-4000-8000-0000000000a1', 'amount_ex', 600),
  jsonb_build_object('line_id', l.id, 'target', 'overhead', 'amount_ex', 300),
  jsonb_build_object('line_id', l.id, 'target', 'division_stock', 'division', 'fencing', 'amount_ex', 100));
 PERFORM pg_temp.decide(i, 'split', s);
 l := pg_temp.line('SPLIT');
 IF l.state <> 'split' OR (SELECT string_agg(target || ':' || amount_ex, ',' ORDER BY part_no)
   FROM public.job_cost_line_parts WHERE line_id = l.id) <> 'job:600.00,overhead:300.00,division_stock:100.00' THEN
  RAISE EXCEPTION 'P2-03.3 a split that adds up must commit its three parts'; END IF;
END $split$;

-- overhead, division_stock and duplicate.
DO $states$
DECLARE i uuid; l public.job_cost_lines;
/* block */ BEGIN
 i := pg_temp.item('OVER');
 PERFORM pg_temp.decide(i, 'overhead', NULL);
 l := pg_temp.line('OVER');
 IF l.state <> 'overhead' OR (SELECT target || ':' || amount_ex FROM public.job_cost_line_parts
   WHERE line_id = l.id) <> 'overhead:100.00' THEN
  RAISE EXCEPTION 'P2-03.3 overhead must file the line as overhead'; END IF;

 i := pg_temp.item('DIV');
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'division_stock','[{"division":"roofing"}]')$f$, i),
  'reconcile_division_unknown');
 PERFORM pg_temp.decide(i, 'division_stock', '[{"division":"fencing"}]');
 l := pg_temp.line('DIV');
 IF l.state <> 'division_stock' OR (SELECT division FROM public.job_cost_line_parts WHERE line_id = l.id) <> 'fencing' THEN
  RAISE EXCEPTION 'P2-03.3 division_stock must file the line to the division'; END IF;

 i := pg_temp.item('DUP');
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'duplicate','[]')$f$, i),
  'reconcile_duplicate_needs_other');
 PERFORM pg_temp.decide(i, 'duplicate', '[{"other_document_id":"xero_bill:ZZTEST-3203-PLACE"}]');
 IF EXISTS(SELECT 1 FROM public.job_cost_lines WHERE document_id = 'ZZTEST-3203-DUP'
     AND (state IS NOT NULL OR not_counted_reason IS DISTINCT FROM 'duplicate_document' OR decided_by_kind <> 'person'))
  OR (SELECT count(*) FROM public.job_cost_lines WHERE document_id = 'ZZTEST-3203-DUP') <> 2
  OR EXISTS(SELECT 1 FROM public.job_cost_line_parts p JOIN public.job_cost_lines dl ON dl.id = p.line_id
     WHERE dl.document_id = 'ZZTEST-3203-DUP') THEN
  RAISE EXCEPTION 'P2-03.3 duplicate must mark every line not counted'; END IF;
END $states$;

-- leave: no change; the item stays open, snoozed; the decision is recorded.
DO $leave$
DECLARE i uuid := pg_temp.item('LEAVE'); r jsonb; it public.reconcile_items; d2 jsonb;
/* block */ BEGIN
 r := pg_temp.decide(i, 'leave', NULL);
 SELECT * INTO it FROM public.reconcile_items WHERE id = i;
 IF r ->> 'item_status' <> 'open' OR it.status <> 'open' OR it.snooze_until < now() + interval '23 hours'
  OR (pg_temp.line('LEAVE')).state <> 'needs_person'
  OR NOT EXISTS(SELECT 1 FROM public.reconcile_decisions WHERE id = (r ->> 'decision_id')::bigint AND action = 'leave') THEN
  RAISE EXCEPTION 'P2-03.3 leave must keep the item open and snooze it'; END IF;
 -- The next decision supersedes the leave.
 d2 := pg_temp.decide(i, 'overhead', NULL);
 IF (SELECT supersedes FROM public.reconcile_decisions WHERE id = (d2 ->> 'decision_id')::bigint)
    <> (r ->> 'decision_id')::bigint THEN
  RAISE EXCEPTION 'P2-03.3 a decision must supersede the subject''s previous one'; END IF;
END $leave$;

-- not_duplicate (ruling): records the decision and closes the item; no lines
-- change, nothing is requeued, and the same hold is not raised again.
DO $not_duplicate$
DECLARE i uuid := pg_temp.dup_item('NOTDUP'); r jsonb; before_line jsonb;
/* block */ BEGIN
 SELECT to_jsonb(l) INTO before_line FROM public.job_cost_lines l WHERE document_id = 'ZZTEST-3203-NOTDUP';
 r := pg_temp.decide(i, 'not_duplicate', NULL);
 IF r ->> 'item_status' <> 'decided' OR (SELECT status FROM public.reconcile_items WHERE id = i) <> 'decided'
  OR (SELECT to_jsonb(l) FROM public.job_cost_lines l WHERE document_id = 'ZZTEST-3203-NOTDUP') IS DISTINCT FROM before_line
  OR NOT EXISTS(SELECT 1 FROM public.reconcile_decisions WHERE id = (r ->> 'decision_id')::bigint
     AND action = 'not_duplicate' AND "by" LIKE 'person:%') THEN
  RAISE EXCEPTION 'P2-03.3 not_duplicate must record and close without changing lines'; END IF;
 IF pg_temp.dup_item('NOTDUP') IS NOT NULL THEN
  RAISE EXCEPTION 'P2-03.3 the same hold must not be raised again after not_duplicate'; END IF;
 IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)'::regprocedure)
    ~* 'requeue' THEN
  RAISE EXCEPTION 'P2-03.3 must not call or stub a requeue'; END IF;
END $not_duplicate$;

-- resolve: items that are not cost documents; a note is required.
DO $resolve$
DECLARE i uuid; r jsonb;
/* block */ BEGIN
 i := public.reconcile_item_raise('open_item_check', 'jobs', '32030000-0000-4000-8000-0000000000a2', NULL, NULL,
  '{"reason":"zz_check"}'::jsonb, 'migration');
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'resolve',NULL,'  ')$f$, i), 'reconcile_note_required');
 PERFORM pg_temp.expect_failure(format($f$SELECT pg_temp.decide(%L,'place',%L)$f$, i,
  '[{"job_id":"32030000-0000-4000-8000-0000000000a2"}]'), 'reconcile_action_not_for_item');
 r := pg_temp.decide(i, 'resolve', NULL, 'checked with the office');
 IF r ->> 'item_status' <> 'decided' OR r -> 'lines' <> '[]'::jsonb
  OR (SELECT note FROM public.reconcile_decisions WHERE id = (r ->> 'decision_id')::bigint) <> 'checked with the office' THEN
  RAISE EXCEPTION 'P2-03.3 resolve must record the note and close the item'; END IF;
END $resolve$;

-- Service role only.
DO $grants$ /* block */ BEGIN
 IF has_function_privilege('authenticated','public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)','EXECUTE')
 OR has_function_privilege('anon','public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'P2-03.3 reconcile_decide must be service role only'; END IF;
END $grants$;

-- Rule 16: the document's lines and their parts are read by index.
SAVEPOINT plan_fixture;
INSERT INTO public.job_cost_lines(org_id, kind, document_kind, document_id, line_key, lane, amount_ex, source_hash, state)
SELECT '00000000-0000-0000-0000-0000000000a1', 'supplier_bill', 'xero_bill', 'ZZTEST-3203-PLAN-' || g, '1',
 'materials', 1, 'zz', 'overhead' FROM generate_series(1, 4000) g;
INSERT INTO public.job_cost_line_parts(line_id, part_no, target, lane, amount_ex)
SELECT id, 1, 'overhead', 'materials', 1 FROM public.job_cost_lines WHERE document_id LIKE 'ZZTEST-3203-PLAN-%';
ANALYZE public.job_cost_lines, public.job_cost_line_parts;
DO $plan$
DECLARE plan jsonb; q text; rel text;
/* block */ BEGIN
 FOR rel, q IN VALUES
  ('job_cost_lines', $q$SELECT l.id FROM public.job_cost_lines l WHERE l.document_kind = 'xero_bill'
    AND l.document_id = 'ZZTEST-3203-PLAN-17' AND l.org_id = '00000000-0000-0000-0000-0000000000a1'$q$),
  ('job_cost_line_parts', $q$SELECT p.amount_ex FROM public.job_cost_line_parts p WHERE p.line_id =
    (SELECT id FROM public.job_cost_lines WHERE document_kind = 'xero_bill' AND document_id = 'ZZTEST-3203-PLAN-17')$q$)
 LOOP
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || q INTO plan;
  IF EXISTS(SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
     WHERE node->>'Relation Name' IN ('job_cost_lines','job_cost_line_parts') AND node->>'Node Type' = 'Seq Scan')
  OR NOT EXISTS(SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
     WHERE node->>'Relation Name' = rel AND node->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan'))
  OR EXISTS(SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
     WHERE node->>'Relation Name' = rel AND
       coalesce((node->>'Actual Rows')::numeric,0) + coalesce((node->>'Rows Removed by Filter')::numeric,0) > 2) THEN
   RAISE EXCEPTION 'P2-03.3 % read must be bounded and indexed: %', rel, plan; END IF;
 END LOOP;
END $plan$;
ROLLBACK TO plan_fixture;

SELECT 'PASS P2-03.3: staff only, stale evidence refused, place, split, overhead, division_stock, duplicate, leave, not_duplicate closes without requeue, resolve, refusals write nothing, indexed reads';
ROLLBACK;
