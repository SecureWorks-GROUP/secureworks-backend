\set ON_ERROR_STOP on
BEGIN;
-- A re-apply is a no-op on this migration's own bodies.
\ir ../../../migrations/20261119010000_match_apply_held_unchanged.sql
SET LOCAL statement_timeout = '60s';
CREATE TEMP TABLE held_checks(label text);
CREATE FUNCTION pg_temp.check_it(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'failed: %',label; END IF;
 INSERT INTO held_checks VALUES(label);
END $$;
SELECT pg_temp.check_it(
  (SELECT md5(prosrc)='a63d82c7f7a24ea5a99c0933bec7352a' FROM pg_proc
    WHERE oid='public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure)
  AND (SELECT md5(prosrc)='f228062ecc1a3a69e266533282028e5e' FROM pg_proc
    WHERE oid='public.match_clues_unchanged(text,text,jsonb,text)'::regprocedure),'bodies after a re-apply');
SELECT pg_temp.check_it(has_function_privilege('service_role','public.match_clues_unchanged(text,text,jsonb,text)','execute')
  AND NOT has_function_privilege('authenticated','public.match_clues_unchanged(text,text,jsonb,text)','execute')
  AND NOT has_function_privilege('anon','public.match_clues_unchanged(text,text,jsonb,text)','execute')
  AND has_function_privilege('service_role','public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)','execute')
  AND NOT has_function_privilege('authenticated','public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)','execute'),
  'service-only functions, match_apply grants kept');

INSERT INTO public.users(id,org_id,name,role) VALUES
 ('03050000-0000-4000-8000-000000000001','00000000-0000-0000-0000-0000000000a1','office','ops_manager');
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
 ('03050000-0000-4000-8000-000000000004','00000000-0000-0000-0000-0000000000a1','ZZTEST-0305','fencing','accepted');
INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,source_hash,state,needs_reason,lane,amount_ex)
 SELECT '00000000-0000-0000-0000-0000000000a1','supplier_bill','xero_bill','ZZTEST-0305-'||d,'1',
   'source','needs_person','new','materials',12 FROM unnest(ARRAY['undo','person','free','off']) d;
CREATE FUNCTION pg_temp.subject(d text) RETURNS text LANGUAGE sql AS $$ SELECT 'xero_bill:ZZTEST-0305-'||d $$;
-- The clues exactly as the runner's clueJson emits them: all nine keys, nulls and an empty detail,
-- one clue naming the job and one naming none.
CREATE FUNCTION pg_temp.clues(d text,order_ref text DEFAULT 'ZZTEST-order') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_array(
  jsonb_build_object('clue_code','job_number','root','doc:'||d,'outcome','job',
    'job_id','03050000-0000-4000-8000-000000000004','division',NULL,'names_one',true,
    'seen_where','reference','seen_value','ZZTEST-0305','detail','{}'::jsonb),
  jsonb_build_object('clue_code','sealed_scope_order','root','order:'||order_ref,'outcome','job',
    'job_id','03050000-0000-4000-8000-000000000004','division',NULL,'names_one',true,
    'seen_where',NULL,'seen_value',NULL,'detail',jsonb_build_object('order_kind','dispatch_order','order_id',order_ref)),
  jsonb_build_object('clue_code','overhead_account','root','doc:'||d||':account','outcome','overhead',
    'job_id',NULL,'division',NULL,'names_one',false,'seen_where','line','seen_value','400','detail','{}'::jsonb))
$$;
CREATE FUNCTION pg_temp.run(d text,result jsonb,clues jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.match_apply('cost_document',pg_temp.subject(d),gen_random_uuid(),'bill',
   coalesce(clues,pg_temp.clues(d)),result,'[]','{}','v1')
$$;
CREATE FUNCTION pg_temp.auto() RETURNS jsonb LANGUAGE sql AS $$
 SELECT '{"result":"auto","job_id":"03050000-0000-4000-8000-000000000004","clue_indexes":[0,1]}'::jsonb
$$;
CREATE FUNCTION pg_temp.suggest() RETURNS jsonb LANGUAGE sql AS $$
 SELECT '{"result":"suggest","reason":"office_confirms","outcome":"job","job_id":"03050000-0000-4000-8000-000000000004","from_clue_index":0,"clue_indexes":[0,1]}'::jsonb
$$;
-- Every clue row ever written for the bill, and the current run-written ones in order.
CREATE FUNCTION pg_temp.rows(d text) RETURNS bigint LANGUAGE sql AS $$
 SELECT count(*) FROM public.match_clues WHERE subject_kind='cost_document' AND subject_id=pg_temp.subject(d)
$$;
CREATE FUNCTION pg_temp.current_ids(d text) RETURNS bigint[] LANGUAGE sql AS $$
 SELECT array_agg(id ORDER BY id) FROM public.match_clues WHERE current AND kept_from IS NULL
   AND subject_kind='cost_document' AND subject_id=pg_temp.subject(d)
$$;

UPDATE public.feature_flags SET enabled=true WHERE flag_name='reconcile_matcher_v1';

DO $keys$
DECLARE c jsonb := pg_temp.clues('free');
BEGIN
 PERFORM pg_temp.check_it(public.match_clues_unchanged('cost_document',pg_temp.subject('free'),'[]','v1'),
   'no clues and none current is unchanged');
 PERFORM pg_temp.check_it(NOT public.match_clues_unchanged('cost_document',pg_temp.subject('free'),c,'v1'),
   'fresh clues with none current is a change');
 PERFORM pg_temp.run('free',pg_temp.suggest(),c);
 PERFORM pg_temp.check_it(public.match_clues_unchanged('cost_document',pg_temp.subject('free'),c,'v1'),
   'the key read from the clues agrees with the stored rows, job and no job');
 PERFORM pg_temp.check_it(NOT public.match_clues_unchanged('cost_document',pg_temp.subject('free'),
   jsonb_build_array(c->1,c->0,c->2),'v1'),'another order is a change');
 PERFORM pg_temp.check_it(NOT public.match_clues_unchanged('cost_document',pg_temp.subject('free'),
   jsonb_build_array(c->0,c->1),'v1'),'a clue gone is a change');
 PERFORM pg_temp.check_it(NOT public.match_clues_unchanged('cost_document',pg_temp.subject('free'),
   jsonb_set(c,'{0,seen_value}','"ZZTEST-other"'),'v1'),'a value changed is a change');
 PERFORM pg_temp.check_it(NOT public.match_clues_unchanged('cost_document',pg_temp.subject('free'),
   jsonb_set(c,'{2,clue_code}','"zz_unknown_type"'),'v1'),'an unknown type is never unchanged');
END $keys$;

-- Held by an undo receipt: unchanged clues write nothing; changed clues are rewritten and may release.
DO $undo$
DECLARE r jsonb; n bigint; ids bigint[]; k int;
BEGIN
 r := pg_temp.run('undo',pg_temp.auto());
 PERFORM pg_temp.check_it(r->>'applied'='auto','placed before the undo');
 PERFORM public.reconcile_undo((r->>'decision_id')::bigint,'03050000-0000-4000-8000-000000000001');
 n := pg_temp.rows('undo'); ids := pg_temp.current_ids('undo');
 FOR k IN 1..3 LOOP
   r := pg_temp.run('undo',CASE WHEN k=2 THEN pg_temp.suggest() ELSE pg_temp.auto() END);
   PERFORM pg_temp.check_it(r='{"applied":"held_by_person"}','held on every pass');
 END LOOP;
 PERFORM pg_temp.check_it(pg_temp.rows('undo')=n AND pg_temp.current_ids('undo')=ids,
   'three held passes with the same clues write no clue row');
 r := pg_temp.run('undo',pg_temp.auto(),pg_temp.clues('undo','ZZTEST-other-order'));
 PERFORM pg_temp.check_it(r->>'applied'='auto' AND pg_temp.rows('undo')=n+3,
   'changed clues are rewritten once and the undo receipt lets go');
END $undo$;

-- Held by a person's decision: the first pass writes the clues, the next ones write nothing.
DO $person$
DECLARE i uuid; n bigint; ids bigint[]; r jsonb; k int;
BEGIN
 i := public.reconcile_item_raise('bill','cost_document',pg_temp.subject('person'),'{}',NULL,
   '{"reason":"one_clue"}','matcher:v1');
 PERFORM public.reconcile_decide(i,(SELECT evidence_hash FROM public.reconcile_items WHERE id=i),'overhead',NULL,NULL,false,
   '03050000-0000-4000-8000-000000000001');
 r := pg_temp.run('person',pg_temp.suggest());
 PERFORM pg_temp.check_it(r='{"applied":"held_by_person"}' AND pg_temp.rows('person')=3,'first held pass writes the new clues');
 n := pg_temp.rows('person'); ids := pg_temp.current_ids('person');
 FOR k IN 1..2 LOOP
   r := pg_temp.run('person',pg_temp.suggest());
   PERFORM pg_temp.check_it(r='{"applied":"held_by_person"}','held again');
 END LOOP;
 PERFORM pg_temp.check_it(pg_temp.rows('person')=n AND pg_temp.current_ids('person')=ids,'later held passes write nothing');
END $person$;

-- Not held: every pass still writes, as on main.
DO $free$
DECLARE n bigint := pg_temp.rows('free'); ids bigint[] := pg_temp.current_ids('free'); r jsonb;
BEGIN
 r := pg_temp.run('free',pg_temp.suggest(),pg_temp.clues('free'));
 PERFORM pg_temp.check_it(r->>'applied'='item' AND pg_temp.rows('free')=n+3 AND pg_temp.current_ids('free')<>ids,
   'a bill that is not held is unchanged');
END $free$;

-- Switch off: the shadow path keeps one clue set and one shadow row per run, as on main.
DO $off$
DECLARE n bigint; s bigint; r jsonb;
BEGIN
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='reconcile_matcher_v1';
 PERFORM pg_temp.run('off',pg_temp.suggest());
 n := pg_temp.rows('off');
 SELECT count(*) INTO s FROM public.match_shadow_runs WHERE subject_id=pg_temp.subject('off');
 r := pg_temp.run('off',pg_temp.suggest());
 PERFORM pg_temp.check_it(r='{"applied":"shadow"}' AND pg_temp.rows('off')=n+3
   AND (SELECT count(*) FROM public.match_shadow_runs WHERE subject_id=pg_temp.subject('off'))=s+1,
   'switch off writes clues and a shadow row on every run');
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='reconcile_matcher_v1';
END $off$;

SET LOCAL enable_seqscan=off;
DO $plan$
DECLARE plan json;
BEGIN
 EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) SELECT id FROM public.match_clues WHERE current AND kept_from IS NULL'
   ||' AND subject_kind=''cost_document'' AND subject_id=''xero_bill:ZZTEST-0305-person''' INTO plan;
 PERFORM pg_temp.check_it(plan::text !~ 'Seq Scan' AND plan::text ~ '(Index Scan|Index Only Scan|Bitmap Index Scan)',
   'current clues read on the subject index');
END $plan$;

SELECT 'PASS P2-02.8: '||count(*)||' checks' FROM held_checks;
ROLLBACK;
