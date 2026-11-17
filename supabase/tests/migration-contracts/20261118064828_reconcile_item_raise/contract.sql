BEGIN;
SET LOCAL statement_timeout = '120s';
-- Rule 17: re-apply what this contract asserts. P2-03.1 is re-applied only if an
-- earlier contract removed it; this migration is always re-applied.
SELECT to_regclass('public.reconcile_items') IS NULL AS raise_contract_needs_tables \gset
\if :raise_contract_needs_tables
\ir ../20261118060051_reconcile_tables/main_lines_reader.sql
\ir ../../../migrations/20261118060051_reconcile_tables.sql
\endif
\ir ../../../migrations/20261118064828_reconcile_item_raise.sql
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION pg_temp.expect_failure(command text, expected text) RETURNS void
LANGUAGE plpgsql AS $expect$
DECLARE failed boolean := false;
/* block */ BEGIN
 BEGIN EXECUTE command;
 EXCEPTION WHEN OTHERS THEN
  IF position(expected IN SQLERRM) = 0 THEN RAISE; END IF;
  failed := true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'expected refusal: %', expected; END IF;
END $expect$;

-- Fixtures: org A ...a1, org B ...b1. Roles and job numbers only.
INSERT INTO public.jobs(id, org_id, job_number, type, status) VALUES
 ('32020000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'ZZTEST-3202-A1', 'fencing', 'accepted'),
 ('32020000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'ZZTEST-3202-A2', 'fencing', 'accepted'),
 ('32020000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'ZZTEST-3202-B1', 'fencing', 'accepted');
CREATE TABLE public.zztest_recon_subject(id uuid PRIMARY KEY, org_id uuid);
CREATE TABLE public.zztest_recon_noorg(id bigint PRIMARY KEY, note text);
INSERT INTO public.zztest_recon_subject VALUES
 ('32020000-0000-4000-8000-0000000005b1', '00000000-0000-0000-0000-0000000000b1'),
 ('32020000-0000-4000-8000-0000000005a1', '00000000-0000-0000-0000-0000000000a1'),
 ('32020000-0000-4000-8000-000000000500', NULL);
INSERT INTO public.zztest_recon_noorg VALUES (1, 'subject without an organisation column');
INSERT INTO public.job_cost_lines(org_id, kind, document_kind, document_id, line_key, lane, source_hash, state)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'supplier_bill', 'xero_bill', 'ZZTEST-3202-BILL', '1', 'materials', 'zz', 'needs_person'),
 ('00000000-0000-0000-0000-0000000000a1', 'supplier_bill', 'xero_bill', 'ZZTEST-3202-TWO', '1', 'materials', 'zz', 'needs_person'),
 ('00000000-0000-0000-0000-0000000000b1', 'supplier_bill', 'xero_bill', 'ZZTEST-3202-TWO', '1', 'materials', 'zz', 'needs_person');

-- Organisation from the subject row's own org_id (first, so the break proof
-- fails here and nowhere earlier).
DO $subject_org$
DECLARE v uuid;
/* block */ BEGIN
 v := public.reconcile_item_raise('open_item_check', 'zztest_recon_subject',
  '32020000-0000-4000-8000-0000000005b1', NULL, NULL,
  '{"reason":"zz_subject"}'::jsonb, 'migration');
 IF (SELECT org_id FROM public.reconcile_items WHERE id = v) IS DISTINCT FROM
    '00000000-0000-0000-0000-0000000000b1' THEN
  RAISE EXCEPTION 'P2-03.2 organisation must come from the subject row'; END IF;
 IF (SELECT job_ids FROM public.reconcile_items WHERE id = v) <> '{}'::uuid[] THEN
  RAISE EXCEPTION 'P2-03.2 NULL job ids must be stored as an empty array'; END IF;
 -- A job subject: the job row's own org_id.
 v := public.reconcile_item_raise('open_item_check', 'jobs',
  '32020000-0000-4000-8000-0000000000b1', NULL, NULL, '{"reason":"zz_job"}'::jsonb, 'migration');
 IF (SELECT org_id FROM public.reconcile_items WHERE id = v) IS DISTINCT FROM
    '00000000-0000-0000-0000-0000000000b1' THEN
  RAISE EXCEPTION 'P2-03.2 a job subject must take the job''s organisation'; END IF;
 -- Jobs named with a subject only confirm its organisation.
 v := public.reconcile_item_raise('open_item_check', 'zztest_recon_subject',
  '32020000-0000-4000-8000-0000000005a1',
  ARRAY['32020000-0000-4000-8000-0000000000a1', '32020000-0000-4000-8000-0000000000a2']::uuid[],
  NULL, '{"reason":"zz_jobs"}'::jsonb, 'migration');
 IF (SELECT org_id FROM public.reconcile_items WHERE id = v) IS DISTINCT FROM
    '00000000-0000-0000-0000-0000000000a1' THEN
  RAISE EXCEPTION 'P2-03.2 jobs in the subject''s organisation must be accepted'; END IF;
END $subject_org$;

-- Refusals. The subject alone decides the organisation: a subject that does
-- not resolve refuses whatever jobs are passed, and every job must exist in that
-- organisation. Each refusal leaves the list exactly as it was.
CREATE TEMP TABLE raise_before AS
 SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]') list FROM public.reconcile_items i;
SELECT pg_temp.expect_failure(format($sql$SELECT public.reconcile_item_raise(%L,%L,%L,%L::uuid[],NULL,
 jsonb_build_object('reason','zz_refused'),'migration')$sql$, k, t, i, j), e)
FROM (VALUES
 -- A missing cost document plus a valid job (HOLD 1).
 ('bill','cost_document','xero_bill:ZZTEST-3202-NONE','{32020000-0000-4000-8000-0000000000a1}','reconcile_org_unknown'),
 ('bill','cost_document','xero_bill:ZZTEST-3202-NONE',NULL,'reconcile_org_unknown'),
 ('bill','cost_document','no-colon','{32020000-0000-4000-8000-0000000000a1}','reconcile_org_unknown'),
 -- A subject that carries no organisation, with or without jobs.
 ('open_item_check','zztest_recon_noorg','1','{32020000-0000-4000-8000-0000000000a1}','reconcile_org_unknown'),
 ('open_item_check','zztest_recon_noorg','1','{32020000-0000-4000-8000-0000000000a1,32020000-0000-4000-8000-0000000000b1}','reconcile_org_unknown'),
 ('open_item_check','zztest_recon_noorg','1',NULL,'reconcile_org_unknown'),
 ('open_item_check','zztest_no_such_table','1','{32020000-0000-4000-8000-0000000000a1}','reconcile_org_unknown'),
 -- A subject row that is missing, malformed or has no organisation, plus a valid job.
 ('open_item_check','zztest_recon_subject','32020000-0000-4000-8000-00000000beef','{32020000-0000-4000-8000-0000000000a1}','reconcile_org_unknown'),
 ('open_item_check','zztest_recon_subject','not-a-uuid',NULL,'reconcile_org_unknown'),
 ('open_item_check','zztest_recon_subject','32020000-0000-4000-8000-000000000500','{32020000-0000-4000-8000-0000000000a1}','reconcile_org_unknown'),
 ('open_item_check','zztest_recon_subject','32020000-0000-4000-8000-000000000500',NULL,'reconcile_org_unknown'),
 -- A valid job does not mask a second, missing one (HOLD 1), nor a null id.
 ('bill','cost_document','xero_bill:ZZTEST-3202-BILL','{32020000-0000-4000-8000-0000000000a1,32020000-0000-4000-8000-00000000dead}','reconcile_job_unknown'),
 ('open_item_check','zztest_recon_subject','32020000-0000-4000-8000-0000000005b1','{32020000-0000-4000-8000-0000000000b1,32020000-0000-4000-8000-00000000dead}','reconcile_job_unknown'),
 ('open_item_check','zztest_recon_subject','32020000-0000-4000-8000-0000000005b1','{32020000-0000-4000-8000-0000000000b1,NULL}','reconcile_job_unknown'),
 -- A job in another organisation than the subject, and a document spanning two.
 ('open_item_check','zztest_recon_subject','32020000-0000-4000-8000-0000000005b1','{32020000-0000-4000-8000-0000000000a1}','reconcile_org_ambiguous'),
 ('bill','cost_document','xero_bill:ZZTEST-3202-BILL','{32020000-0000-4000-8000-0000000000b1}','reconcile_org_ambiguous'),
 ('bill','cost_document','xero_bill:ZZTEST-3202-TWO',NULL,'reconcile_org_ambiguous'),
 ('zztest_not_a_kind','zztest_recon_subject','32020000-0000-4000-8000-0000000005b1',NULL,'reconcile_kind_unknown')
) v(k, t, i, j, e);
DO $none_written$ /* block */ BEGIN
 IF (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]') FROM public.reconcile_items i)
    IS DISTINCT FROM (SELECT list FROM raise_before) THEN
  RAISE EXCEPTION 'P2-03.2 a refused raise must leave the list unchanged'; END IF;
END $none_written$;

-- The ticket's cases on a cost document (organisation from its lines).
DO $ticket$
DECLARE
 j uuid[] := ARRAY['32020000-0000-4000-8000-0000000000a1']::uuid[];
 ev jsonb := '{"reason":"one_clue","amount_ex":1234.5,"document_date":"2026-11-02","summary":{"party":"ZZTEST supplier","number":"ZZ-1"}}';
 sg jsonb := '{"outcome":"job","job_id":"32020000-0000-4000-8000-0000000000a1"}';
 a uuid; b uuid; c uuid; d uuid; h text; r public.reconcile_items%ROWTYPE;
/* block */ BEGIN
 a := public.reconcile_item_raise('bill','cost_document','xero_bill:ZZTEST-3202-BILL',j,sg,ev,'matcher:v1');
 b := public.reconcile_item_raise('bill','cost_document','xero_bill:ZZTEST-3202-BILL',j,sg,ev,'matcher:v1');
 IF a IS NULL OR a <> b OR (SELECT count(*) FROM public.reconcile_items
   WHERE subject_table='cost_document' AND subject_id='xero_bill:ZZTEST-3202-BILL') <> 1 THEN
  RAISE EXCEPTION 'P2-03.2 two raises must return one item'; END IF;
 SELECT * INTO r FROM public.reconcile_items WHERE id = a;
 IF r.org_id <> '00000000-0000-0000-0000-0000000000a1' OR r.amount_ex <> 1234.50
  OR r.document_date <> DATE '2026-11-02' OR r.reason <> 'one_clue'
  OR r.summary <> '{"party":"ZZTEST supplier","number":"ZZ-1"}'::jsonb OR r.evidence <> ev
  OR r.job_ids <> j OR r.suggestion <> sg OR r.raised_by <> 'matcher:v1' OR r.status <> 'open'
  OR r.evidence_hash <> md5(ev::text || sg::text || j::text) THEN
  RAISE EXCEPTION 'P2-03.2 evidence must land in its columns: %', row_to_json(r); END IF;

 c := public.reconcile_item_raise('credit','cost_document','xero_bill:ZZTEST-3202-BILL',j,sg,ev,'matcher:v1');
 IF c IS NULL OR c = a THEN RAISE EXCEPTION 'P2-03.2 another kind must make a second item'; END IF;

 PERFORM public.reconcile_item_raise('bill','cost_document','xero_bill:ZZTEST-3202-BILL',j,
  '{"outcome":"overhead"}'::jsonb,ev,'matcher:v1');
 SELECT * INTO r FROM public.reconcile_items WHERE id = a;
 IF r.suggestion <> '{"outcome":"overhead"}'::jsonb OR r.evidence_hash = md5(ev::text || sg::text || j::text) THEN
  RAISE EXCEPTION 'P2-03.2 a changed suggestion must update the open item'; END IF;

 IF NOT public.reconcile_item_withdraw('credit','cost_document','xero_bill:ZZTEST-3202-BILL','bill_voided') THEN
  RAISE EXCEPTION 'P2-03.2 withdraw must close the open item'; END IF;
 IF public.reconcile_item_withdraw('credit','cost_document','xero_bill:ZZTEST-3202-BILL','bill_voided') THEN
  RAISE EXCEPTION 'P2-03.2 a second withdraw must change nothing'; END IF;
 SELECT * INTO r FROM public.reconcile_items WHERE id = c;
 IF r.status <> 'withdrawn' OR r.closed_at IS NULL OR r.summary ->> 'withdrawn_reason' <> 'bill_voided'
  OR r.summary ->> 'party' <> 'ZZTEST supplier' THEN
  RAISE EXCEPTION 'P2-03.2 withdraw must keep the summary and add its reason'; END IF;

 -- A person decides on the evidence they were shown; the same raise stays off.
 SELECT evidence_hash INTO h FROM public.reconcile_items WHERE id = a;
 UPDATE public.reconcile_items SET status = 'decided', closed_at = now() WHERE id = a;
 INSERT INTO public.reconcile_decisions(org_id,item_id,subject_kind,subject_id,action,shown_hash,"by")
 VALUES('00000000-0000-0000-0000-0000000000a1',a,'cost_document','xero_bill:ZZTEST-3202-BILL','overhead',h,
  'person:00000000-0000-4000-8000-000000000001');
 IF public.reconcile_item_raise('bill','cost_document','xero_bill:ZZTEST-3202-BILL',j,
   '{"outcome":"overhead"}'::jsonb,ev,'matcher:v1') IS NOT NULL THEN
  RAISE EXCEPTION 'P2-03.2 a person''s decision on the same evidence must not be reopened'; END IF;
 -- The office's newer word on the document reopens nothing it already closed.
 IF (SELECT count(*) FROM public.reconcile_items WHERE kind='bill'
   AND subject_id='xero_bill:ZZTEST-3202-BILL' AND status='open') <> 0 THEN
  RAISE EXCEPTION 'P2-03.2 a NULL raise must leave no open item'; END IF;

 d := public.reconcile_item_raise('bill','cost_document','xero_bill:ZZTEST-3202-BILL',j,
  '{"outcome":"overhead"}'::jsonb,ev || '{"summary":{"party":"ZZTEST supplier","number":"ZZ-1","lines":2}}'::jsonb,
  'matcher:v1');
 IF d IS NULL OR d = a OR (SELECT status FROM public.reconcile_items WHERE id = d) <> 'open'
  OR (SELECT summary ->> 'lines' FROM public.reconcile_items WHERE id = d) <> '2' THEN
  RAISE EXCEPTION 'P2-03.2 changed evidence after a decision must open a new item'; END IF;

 -- Missing, empty or malformed reason, and malformed evidence fields.
 PERFORM pg_temp.expect_failure(format($f$SELECT public.reconcile_item_raise('bill','cost_document',
  'xero_bill:ZZTEST-3202-BILL',NULL,NULL,%L::jsonb,'matcher:v1')$f$, x), 'reconcile_reason_required')
 FROM unnest(ARRAY['{"amount_ex":1}', '{"reason":""}', '{"reason":7}', '[]', 'null']) x;
 PERFORM pg_temp.expect_failure($f$SELECT public.reconcile_item_raise('bill','cost_document',
  'xero_bill:ZZTEST-3202-BILL',NULL,NULL,NULL,'matcher:v1')$f$, 'reconcile_reason_required');
 PERFORM pg_temp.expect_failure(format($f$SELECT public.reconcile_item_raise('bill','cost_document',
  'xero_bill:ZZTEST-3202-BILL',NULL,NULL,%L::jsonb,'matcher:v1')$f$, x), 'reconcile_evidence_invalid')
 FROM unnest(ARRAY['{"reason":"r","amount_ex":"12"}', '{"reason":"r","document_date":"tomorrowish"}',
  '{"reason":"r","summary":"words"}']) x;
END $ticket$;

-- Only a person's newest decision on the same evidence keeps a raise off.
DO $not_blocking_jobs$
DECLARE j uuid[] := ARRAY['32020000-0000-4000-8000-0000000000a1']::uuid[];
 ev jsonb := '{"reason":"zz_not_blocking"}'; h text; v uuid; act text; who text;
/* block */ BEGIN
 h := md5(ev::text || '' || j::text);
 FOR act, who IN VALUES ('place','matcher:v1'), ('undo','person:00000000-0000-4000-8000-000000000001'),
   ('leave','person:00000000-0000-4000-8000-000000000001') LOOP
  PERFORM public.reconcile_item_withdraw('open_item_check','zztest_recon_subject','32020000-0000-4000-8000-0000000005a1','zz_reset');
  INSERT INTO public.reconcile_decisions(org_id,subject_kind,subject_id,action,shown_hash,"by")
  VALUES('00000000-0000-0000-0000-0000000000a1','zztest_recon_subject','32020000-0000-4000-8000-0000000005a1',act,h,who);
  v := public.reconcile_item_raise('open_item_check','zztest_recon_subject','32020000-0000-4000-8000-0000000005a1',j,NULL,ev,'migration');
  IF v IS NULL THEN RAISE EXCEPTION 'P2-03.2 a % by % must not keep the item off', act, who; END IF;
 END LOOP;
END $not_blocking_jobs$;

-- Retry after a refusal on an open item: the item is left exactly as it was.
DO $retry$
DECLARE before_row jsonb;
/* block */ BEGIN
 SELECT to_jsonb(i) INTO before_row FROM public.reconcile_items i
 WHERE kind='open_item_check' AND subject_table='zztest_recon_subject' AND subject_id='32020000-0000-4000-8000-0000000005a1' AND status='open';
 FOR n IN 1..2 LOOP
  PERFORM pg_temp.expect_failure($f$SELECT public.reconcile_item_raise('open_item_check','zztest_recon_subject','32020000-0000-4000-8000-0000000005a1',
   ARRAY['32020000-0000-4000-8000-0000000000a1','32020000-0000-4000-8000-0000000000b1']::uuid[],NULL,
   '{"reason":"zz_changed"}'::jsonb,'migration')$f$, 'reconcile_org_ambiguous');
 END LOOP;
 IF (SELECT to_jsonb(i) FROM public.reconcile_items i
   WHERE kind='open_item_check' AND subject_table='zztest_recon_subject' AND subject_id='32020000-0000-4000-8000-0000000005a1' AND status='open')
   IS DISTINCT FROM before_row THEN
  RAISE EXCEPTION 'P2-03.2 a refused raise must leave the open item unchanged'; END IF;
END $retry$;

-- The caller shape of the group-claim sweep (P1-13.9). The real table carries
-- id and org_id, so its own row decides; a missing group refuses rather than
-- falling back to the job.
DO $group_claim$
DECLARE v uuid;
/* block */ BEGIN
 IF to_regclass('public.group_work_orders') IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.group_work_orders'::regclass
     AND attname='org_id' AND NOT attisdropped) THEN
   RAISE EXCEPTION 'P2-03.2 group_work_orders must carry org_id'; END IF;
  PERFORM pg_temp.expect_failure($f$SELECT public.reconcile_item_raise('group_claim_no_agreement','group_work_orders',
   '32020000-0000-4000-8000-00000000cafe',ARRAY['32020000-0000-4000-8000-0000000000a1']::uuid[],
   '{"action":"settle_group_claim"}'::jsonb,'{"reason":"group_no_answer_48h"}'::jsonb,'phase1:group_claim')$f$,
   'reconcile_org_unknown');
 END IF;
 v := public.reconcile_item_raise('group_claim_no_agreement','zztest_recon_subject',
  '32020000-0000-4000-8000-0000000005b1',ARRAY['32020000-0000-4000-8000-0000000000b1']::uuid[],
  jsonb_build_object('action','settle_group_claim','words','Check the hours with the crew.'),
  jsonb_build_object('reason','group_no_answer_48h','amount_ex',NULL::numeric,
   'summary',jsonb_build_object('words','The crew did not agree the split in 48 hours.','job_number','ZZTEST-3202-B1'),
   'previous_state','waiting','deadline_at',now()),
  'phase1:group_claim');
 IF (SELECT amount_ex IS NULL AND org_id='00000000-0000-0000-0000-0000000000b1'
   AND reason='group_no_answer_48h' FROM public.reconcile_items WHERE id=v) IS NOT TRUE THEN
  RAISE EXCEPTION 'P2-03.2 the group-claim call shape must raise with a null amount'; END IF;
END $group_claim$;

-- The list's table comment names this function as its only inserter.
DO $sole_inserter$ /* block */ BEGIN
 IF position('Only reconcile_item_raise inserts items' IN
    coalesce(obj_description('public.reconcile_items'::regclass, 'pg_class'), '')) = 0 THEN
  RAISE EXCEPTION 'P2-03.2 reconcile_items must name reconcile_item_raise as its only inserter'; END IF;
END $sole_inserter$;

-- Service role only.
DO $grants$ /* block */ BEGIN
 IF has_function_privilege('authenticated','public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)','EXECUTE')
 OR has_function_privilege('anon','public.reconcile_item_withdraw(text,text,text,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.reconcile_item_org(text,text,uuid[])','EXECUTE')
 OR NOT has_function_privilege('service_role','public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.reconcile_item_withdraw(text,text,text,text)','EXECUTE') THEN
  RAISE EXCEPTION 'P2-03.2 functions must be service role only'; END IF;
END $grants$;

-- Rule 16: every read the raise makes is index-bound on a populated table.
SAVEPOINT plan_fixture;
INSERT INTO public.job_cost_lines(org_id, kind, document_kind, document_id, line_key, lane, source_hash, state)
SELECT '00000000-0000-0000-0000-0000000000a1', 'supplier_bill', 'xero_bill', 'ZZTEST-PLAN-' || g, '1',
 'materials', 'zz', 'needs_person' FROM generate_series(1, 4000) g;
INSERT INTO public.zztest_recon_subject
SELECT ('32020000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, '00000000-0000-0000-0000-0000000000a1'
FROM generate_series(4096, 8095) g;
INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by)
SELECT '00000000-0000-0000-0000-0000000000a1','bill','cost_document','xero_bill:ZZTEST-PLAN-' || g,'zz','zz','migration'
FROM generate_series(1, 4000) g;
INSERT INTO public.reconcile_decisions(org_id,subject_kind,subject_id,action,"by")
SELECT '00000000-0000-0000-0000-0000000000a1','cost_document','xero_bill:ZZTEST-PLAN-' || g,'place','matcher:v1'
FROM generate_series(1, 4000) g;
ANALYZE public.job_cost_lines, public.zztest_recon_subject, public.reconcile_items, public.reconcile_decisions;
DO $plan$
DECLARE plan jsonb; q text; rel text;
/* block */ BEGIN
 FOR rel, q IN VALUES
  ('job_cost_lines', $q$SELECT array_agg(DISTINCT l.org_id) FROM public.job_cost_lines l
    WHERE l.document_kind = 'xero_bill' AND l.document_id = 'ZZTEST-PLAN-17'$q$),
  ('zztest_recon_subject', $q$SELECT true, t.org_id FROM public.zztest_recon_subject t
    WHERE t.id = '32020000-0000-4000-8000-000000001100'::uuid$q$),
  ('reconcile_items', $q$SELECT * FROM public.reconcile_items i WHERE i.kind = 'bill'
    AND i.subject_table = 'cost_document' AND i.subject_id = 'xero_bill:ZZTEST-PLAN-17' AND i.status = 'open'$q$),
  ('reconcile_decisions', $q$SELECT * FROM public.reconcile_decisions d WHERE d.subject_kind = 'cost_document'
    AND d.subject_id = 'xero_bill:ZZTEST-PLAN-17' ORDER BY d.decided_at DESC, d.id DESC LIMIT 1$q$)
 LOOP
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || q INTO plan;
  IF EXISTS(SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
     WHERE node->>'Relation Name' = rel AND node->>'Node Type' = 'Seq Scan')
  OR NOT EXISTS(SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
     WHERE node->>'Relation Name' = rel
       AND node->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan'))
  OR EXISTS(SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
     WHERE node->>'Relation Name' = rel AND
       coalesce((node->>'Actual Rows')::numeric,0) + coalesce((node->>'Rows Removed by Filter')::numeric,0) > 2) THEN
   RAISE EXCEPTION 'P2-03.2 % read must be bounded and indexed: %', rel, plan; END IF;
 END LOOP;
 -- jobs: the shared CI database holds few jobs, so the planner may rightly
 -- choose a sequential scan; with sequential scans disabled, the plan still
 -- shows one unless an index serves id = ANY(...).
 SET LOCAL enable_seqscan = off;
 EXECUTE $q$EXPLAIN (FORMAT JSON) SELECT j.org_id FROM public.jobs j
  WHERE j.id = ANY(ARRAY['32020000-0000-4000-8000-0000000000a1']::uuid[]) AND j.org_id IS NOT NULL$q$ INTO plan;
 IF EXISTS(SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
    WHERE node->>'Relation Name' = 'jobs' AND node->>'Node Type' = 'Seq Scan') THEN
  RAISE EXCEPTION 'P2-03.2 jobs read must be served by an index: %', plan; END IF;
 RESET enable_seqscan;
END $plan$;
ROLLBACK TO plan_fixture;

SELECT 'PASS P2-03.2: one open item per kind and subject, organisation from the subject alone, jobs confirmed, unresolved subjects and missing jobs refused, person decisions respected, withdraw, refusals write nothing, indexed reads';
ROLLBACK;
