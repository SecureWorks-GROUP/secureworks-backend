BEGIN;
-- Exercise this version and its guarded rollback inside the existing transaction.
SELECT to_regprocedure('public.reconcile_undo(bigint,uuid)') IS NOT NULL AS undo_installed \gset
\if :undo_installed
\ir ../../../rollbacks/20261118195300_reconcile_undo_down.sql
\endif
\ir ../../../migrations/20261118122120_match_apply.sql
SET LOCAL statement_timeout = '60s';

INSERT INTO public.jobs(id, org_id, job_number, type, status) VALUES
 ('02060000-0000-4000-8000-000000000001','02060000-0000-4000-8000-000000000010','SWF-990601','fencing','accepted'),
 ('02060000-0000-4000-8000-000000000002','02060000-0000-4000-8000-000000000020','SWF-990602','fencing','accepted');
INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,document_date,lane,
 amount_ex,source_hash,state,needs_reason)
SELECT '02060000-0000-4000-8000-000000000010','supplier_bill','xero_bill','ZZTEST-0206:' || doc,
 k,'2026-01-01','materials',amount,'test','needs_person','new'
FROM (VALUES ('auto','1',11.11),('auto','2',2.22),('manual','1',7),('manual','2',9),('pdf','1',3),
 ('review','1',2),('fault','1',1),('unknown-amount','1',NULL),('unknown-amount','2',3)) v(doc,k,amount);
UPDATE public.job_cost_lines SET decided_by_kind='person' WHERE document_id='ZZTEST-0206:manual' AND line_key='2';
UPDATE public.feature_flags SET enabled=false WHERE flag_name='reconcile_matcher_v1';

CREATE FUNCTION pg_temp.clue(code text, root text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('clue_code',code,'root',root,'class','ai','family','caller_value_ignored',
   'outcome','job','job_id','02060000-0000-4000-8000-000000000001','names_one',true,
   'detail',CASE WHEN code IN ('sealed_scope_order','order_amount') THEN
   '{"order_kind":"dispatch_order","order_id":"ZZTEST-ORDER"}'::jsonb ELSE '{}' END)
$$;
CREATE FUNCTION pg_temp.pair() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_array(pg_temp.clue('job_number','doc:ZZTEST-0206:auto'),
   pg_temp.clue('sealed_scope_order','order:ZZTEST-ORDER'))
$$;
CREATE FUNCTION pg_temp.apply(doc text, clues jsonb, res jsonb DEFAULT
 '{"result":"auto","job_id":"02060000-0000-4000-8000-000000000001","clue_indexes":[0,1]}',
 stops jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.match_apply('cost_document','xero_bill:ZZTEST-0206:' || doc,gen_random_uuid(),'bill',
   clues,res,stops,'{"number":"ZZTEST"}','v1')
$$;
CREATE FUNCTION pg_temp.check_that(ok boolean, test text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'failed: %', test; END IF; END $$;

DO $shadow$
DECLARE r jsonb;
BEGIN
 r := pg_temp.apply('auto',pg_temp.pair());
 PERFORM pg_temp.check_that(r='{"applied":"shadow"}' AND (SELECT count(*)=1 FROM public.match_shadow_runs
   WHERE subject_id='xero_bill:ZZTEST-0206:auto' AND result->>'result'='auto') AND
   (SELECT count(*)=2 AND bool_and(current AND class='key') FROM public.match_clues WHERE subject_id='xero_bill:ZZTEST-0206:auto')
   AND (SELECT bool_and(state='needs_person') FROM public.job_cost_lines WHERE document_id='ZZTEST-0206:auto')
   AND NOT EXISTS (SELECT FROM public.reconcile_items WHERE subject_id='xero_bill:ZZTEST-0206:auto')
   AND NOT EXISTS (SELECT FROM public.reconcile_decisions WHERE subject_id='xero_bill:ZZTEST-0206:auto'),'shadow');
END $shadow$;

UPDATE public.feature_flags SET enabled=true WHERE flag_name='reconcile_matcher_v1';
DO $review$
DECLARE r jsonb; i public.reconcile_items;
BEGIN
 r := pg_temp.apply('auto',jsonb_build_array(pg_temp.pair()->0),
   '{"result":"suggest","reason":"one_clue","outcome":"job","job_id":"02060000-0000-4000-8000-000000000001","from_clue_index":0}');
 SELECT * INTO STRICT i FROM public.reconcile_items WHERE id=(r->>'item_id')::uuid;
 PERFORM pg_temp.check_that(r->>'applied'='item' AND i.status='open' AND i.reason='one_clue'
  AND i.raised_by='matcher:v1' AND i.amount_ex=13.33 AND i.document_date='2026-01-01'
  AND i.job_ids=ARRAY['02060000-0000-4000-8000-000000000001']::uuid[] AND i.suggestion->>'outcome'='job'
  AND i.suggestion->>'job_id'=i.job_ids[1]::text AND jsonb_array_length(i.suggestion->'clue_ids')=1
  AND i.evidence->'stops'='[]' AND i.summary->>'number'='ZZTEST'
  AND (SELECT bool_and(state='needs_person' AND needs_reason='one_clue') FROM public.job_cost_lines
        WHERE document_id='ZZTEST-0206:auto'),'suggestion and evidence');
END $review$;

DO $placed$
DECLARE r jsonb; d public.reconcile_decisions;
BEGIN
 r := pg_temp.apply('auto',pg_temp.pair());
 SELECT * INTO STRICT d FROM public.reconcile_decisions WHERE id=(r->>'decision_id')::bigint;
 PERFORM pg_temp.check_that(r->>'applied'='auto' AND d."by"='matcher:v1' AND d.action='place'
  AND cardinality(d.clue_ids)=2 AND (SELECT count(*)=2 FROM public.match_clues
   WHERE id=ANY(d.clue_ids) AND current AND subject_id=d.subject_id)
  AND jsonb_array_length(d.before->'lines')=2 AND d.before#>>'{item,status}'='open'
  AND (SELECT bool_and(l->>'state'='needs_person' AND l->>'source_hash'='test' AND l->'parts'='[]')
    FROM jsonb_array_elements(d.before->'lines') l)
  AND (SELECT count(*)=2 AND bool_and(l.state='on_job' AND l.decision_id=d.id AND l.decided_by_kind='matcher'
   AND p.job_id='02060000-0000-4000-8000-000000000001' AND p.amount_ex=l.amount_ex
   AND l.order_kind='dispatch_order' AND l.order_id='ZZTEST-ORDER')
   FROM public.job_cost_lines l JOIN public.job_cost_line_parts p ON p.line_id=l.id WHERE document_id='ZZTEST-0206:auto')
  AND (SELECT status='withdrawn' FROM public.reconcile_items WHERE id=d.item_id)
  AND (SELECT count(*)=1 FROM public.reconcile_decisions WHERE subject_id=d.subject_id),'placement, audit and withdrawal');
 PERFORM pg_temp.check_that(public.match_apply('cost_document',d.subject_id,(d.before->>'run_id')::uuid,'bill',
  pg_temp.pair(),'{"result":"auto","job_id":"02060000-0000-4000-8000-000000000001","clue_indexes":[0,1]}',
  '[]','{"number":"ZZTEST"}','v1')=r AND (SELECT count(*)=1 FROM public.reconcile_decisions
  WHERE subject_id=d.subject_id),'same successful run keeps the undo snapshot');
END $placed$;

DO $held$
BEGIN
 PERFORM pg_temp.check_that(pg_temp.apply('manual',pg_temp.pair())='{"applied":"held_by_person"}','person owns document');
 PERFORM pg_temp.check_that((SELECT bool_and(state='needs_person' AND needs_reason='new') FROM public.job_cost_lines
   WHERE document_id='ZZTEST-0206:manual') AND NOT EXISTS (SELECT FROM public.reconcile_items WHERE subject_id='xero_bill:ZZTEST-0206:manual')
   AND NOT EXISTS (SELECT FROM public.reconcile_decisions WHERE subject_id='xero_bill:ZZTEST-0206:manual'),'whole document preserved');
END $held$;

DO $rechecks$
DECLARE clues jsonb; r jsonb; desired jsonb := '{"result":"auto","job_id":"02060000-0000-4000-8000-000000000001","clue_indexes":[0,1]}';
BEGIN
 FOR clues IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
   jsonb_build_array(pg_temp.clue('order_number','order:A'),pg_temp.clue('sealed_scope_order','order:B')),
   jsonb_build_array(pg_temp.clue('job_number','doc:A'),pg_temp.clue('sealed_scope_order','doc:A')),
   jsonb_build_array(pg_temp.clue('job_number','doc:A'),pg_temp.clue('order_amount','order:A')),
   jsonb_build_array(pg_temp.clue('job_number','doc:A'),pg_temp.clue('ai_read','other:A'))))
 LOOP
  r := pg_temp.apply('review',clues);
  PERFORM pg_temp.check_that(r->>'applied'='item' AND (SELECT reason='recheck_failed' FROM public.reconcile_items
   WHERE id=(r->>'item_id')::uuid),'family, root, mode, class');
 END LOOP;
 r := pg_temp.apply('review',pg_temp.pair(),desired,'[{"code":"possible_duplicate"}]');
 PERFORM pg_temp.check_that(r->>'applied'='item','stop');
 UPDATE public.jobs SET status='quoted' WHERE job_number='SWF-990601';
 r := pg_temp.apply('review',pg_temp.pair());
 PERFORM pg_temp.check_that(r->>'applied'='item','job no longer live');
 UPDATE public.jobs SET status='accepted' WHERE job_number='SWF-990601';
 r := pg_temp.apply('unknown-amount',pg_temp.pair());
 PERFORM pg_temp.check_that(r->>'applied'='item' AND (SELECT amount_ex IS NULL FROM public.reconcile_items
  WHERE id=(r->>'item_id')::uuid),'partial sum stays unknown');
END $rechecks$;

DO $pdf$
DECLARE s text := 'xero_bill:ZZTEST-0206:pdf'; j uuid := '02060000-0000-4000-8000-000000000001';
 first_id bigint; again bigint; order_id bigint; r jsonb;
BEGIN
 first_id := public.match_clue_add(s,'job_number',j,'PDF',NULL,'{}','phase3:bill_pdf');
 again := public.match_clue_add(s,'job_number',j,'PDF',NULL,'{}','phase3:bill_pdf');
 PERFORM pg_temp.check_that(first_id=again AND (SELECT count(*)=1 AND bool_and(current AND kept_from='phase3:bill_pdf'
  AND names_one AND root='doc:ZZTEST-0206:pdf') FROM public.match_clues WHERE subject_id=s)
  AND (SELECT count(*)=1 FROM public.match_queue WHERE subject_id=s),'kept clue and idempotent requeue');
 r := pg_temp.apply('pdf',jsonb_build_array(pg_temp.clue('sealed_scope_order','order:ZZTEST-ORDER')));
 PERFORM pg_temp.check_that(r->>'applied'='auto' AND (SELECT first_id=ANY(clue_ids) FROM public.reconcile_decisions
  WHERE id=(r->>'decision_id')::bigint) AND (SELECT current FROM public.match_clues WHERE id=first_id),'retained clue participates');
 order_id := public.match_clue_add(s,'order_number',j,'PDF',NULL,'{"order_id":"ZZTEST-ORDER"}','phase3:bill_pdf');
 PERFORM pg_temp.check_that((SELECT root='order:ZZTEST-ORDER' FROM public.match_clues WHERE id=order_id),'order root');
 BEGIN PERFORM public.match_clue_add(s,'ai_read',j,NULL,NULL,'{}','phase3:bill_pdf');
  RAISE EXCEPTION 'expected refusal'; EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'match_clue_code_not_allowed' THEN RAISE; END IF; END;
END $pdf$;

DO $missing$
BEGIN
 BEGIN PERFORM pg_temp.apply('absent',pg_temp.pair()); RAISE EXCEPTION 'expected refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'match_subject_unknown' THEN RAISE; END IF; END;
 BEGIN PERFORM pg_temp.apply('fault',jsonb_build_array(pg_temp.clue('job_number','doc:A') ||
   '{"job_id":"02060000-0000-4000-8000-000000000002"}'::jsonb)); RAISE EXCEPTION 'expected refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'reconcile_org_ambiguous' THEN RAISE; END IF; END;
 DELETE FROM public.feature_flags WHERE flag_name='reconcile_matcher_v1';
 BEGIN PERFORM pg_temp.apply('fault',pg_temp.pair()); RAISE EXCEPTION 'expected refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'match_switch_unreadable' THEN RAISE; END IF; END;
 INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES ('reconcile_matcher_v1',true,'test');
END $missing$;

-- A downstream failure after the decision, parts and order have been written.
SELECT pg_temp.apply('fault','[]','{"result":"none","reason":"no_clue"}');
CREATE FUNCTION pg_temp.refuse_withdraw() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fixture_withdraw_failed'; END $$;
CREATE TRIGGER zztest_refuse_withdraw BEFORE UPDATE ON public.reconcile_items FOR EACH ROW
 WHEN (NEW.status='withdrawn') EXECUTE FUNCTION pg_temp.refuse_withdraw();
DO $atomic$
BEGIN
 BEGIN PERFORM pg_temp.apply('fault',pg_temp.pair()); RAISE EXCEPTION 'expected refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'fixture_withdraw_failed' THEN RAISE; END IF; END;
 PERFORM pg_temp.check_that((SELECT state='needs_person' AND decision_id IS NULL AND order_id IS NULL
 FROM public.job_cost_lines WHERE document_id='ZZTEST-0206:fault')
 AND NOT EXISTS (SELECT FROM public.match_clues WHERE subject_id='xero_bill:ZZTEST-0206:fault')
 AND NOT EXISTS (SELECT FROM public.reconcile_decisions WHERE subject_id='xero_bill:ZZTEST-0206:fault')
 AND (SELECT status='open' FROM public.reconcile_items WHERE subject_id='xero_bill:ZZTEST-0206:fault'),'late failure rolls back');
END $atomic$;
DROP TRIGGER zztest_refuse_withdraw ON public.reconcile_items;
SELECT pg_temp.check_that(pg_temp.apply('fault',pg_temp.pair())->>'applied'='auto','retry succeeds');

SELECT pg_temp.check_that(count(*)=5 AND bool_and(has_function_privilege('service_role',oid,'EXECUTE')
 AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE')),
 'five service-only functions') FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND proname IN ('match_apply','match_apply_stop','match_lock_cost_document','match_clue_add','match_requeue');
-- These core table grants exist in the API environment; only this rolled-back
-- fixture supplies them on an empty local cluster.
GRANT SELECT,UPDATE ON public.jobs,public.feature_flags TO service_role;
SET LOCAL ROLE service_role;
SELECT pg_temp.check_that(public.match_apply('cost_document','xero_bill:ZZTEST-0206:manual',gen_random_uuid(),
 'bill','[]','{"result":"none","reason":"no_clue"}','[]','{}','v1')='{"applied":"held_by_person"}',
 'actual service-role entry');
RESET ROLE;
-- Exercise a real denied read through the service-role entry, then restore the grant.
REVOKE SELECT ON public.feature_flags FROM PUBLIC,service_role;
SET LOCAL ROLE service_role;
DO $read_fault$
BEGIN
 BEGIN PERFORM public.match_apply('cost_document','xero_bill:ZZTEST-0206:fault',gen_random_uuid(),'bill',
  '[]','{"result":"none","reason":"no_clue"}','[]','{}','v1');
  RAISE EXCEPTION 'expected read refusal';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $read_fault$;
RESET ROLE;

-- The small fixture proves an available index path; it is not a production timing.
SET LOCAL enable_seqscan=off;
DO $plans$
DECLARE q text; plan json;
BEGIN
 FOREACH q IN ARRAY ARRAY[
   'SELECT status FROM public.jobs WHERE id=''02060000-0000-4000-8000-000000000001''',
   'SELECT org_id FROM public.job_cost_lines WHERE document_kind=''xero_bill'' AND document_id=''ZZTEST-0206:auto''',
   'SELECT id FROM public.match_clues WHERE current AND subject_kind=''cost_document'' AND subject_id=''xero_bill:ZZTEST-0206:auto''',
   'SELECT id FROM public.reconcile_decisions WHERE subject_kind=''cost_document'' AND subject_id=''xero_bill:ZZTEST-0206:auto'' ORDER BY decided_at DESC,id DESC LIMIT 1'
 ] LOOP
   EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) ' || q INTO plan;
   PERFORM pg_temp.check_that(plan::text !~ 'Seq Scan' AND plan::text ~ '(Index Scan|Index Only Scan|Bitmap Index Scan)','indexed lookup');
 END LOOP;
END $plans$;
SET CONSTRAINTS ALL IMMEDIATE;
\ir ../../../rollbacks/20261118122120_match_apply_down.sql
SELECT pg_temp.check_that(to_regprocedure('public.match_apply_stop(text)') IS NULL AND
 to_regprocedure('public.match_clue_add(text,text,uuid,text,text,jsonb,text)') IS NULL AND
 EXISTS (SELECT FROM public.reconcile_decisions WHERE subject_id='xero_bill:ZZTEST-0206:auto'),'rollback preserves audit');
ROLLBACK;
\echo PASS P2-02.6 matcher contract
