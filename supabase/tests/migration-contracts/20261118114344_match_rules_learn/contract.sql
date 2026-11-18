BEGIN;
\ir ../../../migrations/20261118114344_match_rules_learn.sql
CREATE FUNCTION pg_temp.check_ok(v boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'P2-02.12 %',msg; END IF; END $$;
SELECT pg_temp.check_ok(NOT EXISTS (SELECT FROM pg_trigger WHERE tgrelid='public.reconcile_decisions'::regclass
  AND tgname='match_rule_on_decision'), 'unexpected install');
SELECT pg_temp.check_ok(NOT has_function_privilege('service_role','public.match_rule_install()','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.match_rules_proposed()','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.match_rule_confirm(bigint,boolean,uuid)','EXECUTE'),
  'unexpected privilege');

INSERT INTO public.users(id,org_id,role,name) VALUES
 ('62000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000010','ops_manager','ZZTEST staff'),
 ('62000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000010','installer','ZZTEST trade'),
 ('62000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000011','owner','ZZTEST other owner');

CREATE FUNCTION pg_temp.answer(bill text,supplier text,act text,division text DEFAULT NULL,
  prior bigint DEFAULT NULL,actor text DEFAULT 'person:62000000-0000-4000-8000-000000000001')
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE org uuid := '62000000-0000-4000-8000-000000000010'; answer_id bigint;
BEGIN
  INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,lane,state,party_kind,
    party_id,party_name,source_hash) VALUES(org,'supplier_bill','xero_bill',bill,'1','materials','needs_person',
    'supplier',supplier,'ZZTEST supplier','fixture') ON CONFLICT DO NOTHING;
  INSERT INTO public.reconcile_decisions(org_id,subject_kind,subject_id,action,"by",parts,supersedes)
  VALUES(org,'cost_document','xero_bill:'||bill,act,actor,
         CASE WHEN division IS NOT NULL THEN jsonb_build_array(jsonb_build_object('division',division)) END,prior)
  RETURNING id INTO answer_id;
  RETURN answer_id;
END $$;

-- Two pre-install answers count towards a future proposal, but do not change a rule on installation.
SELECT pg_temp.answer('ZZTEST-A1','ZZTEST-A','overhead');
SELECT pg_temp.answer('ZZTEST-A2','ZZTEST-A','overhead');
DO $$ BEGIN WHILE NOT (public.match_rule_install()->>'installed')::boolean LOOP END LOOP; END $$;
SELECT pg_temp.answer('ZZTEST-A3','ZZTEST-A','overhead');
SELECT pg_temp.check_ok((SELECT count(*)=1 FROM public.match_rules WHERE party_id='ZZTEST-A' AND status='proposed'),
 'three overhead answers must propose exactly one rule');
CREATE TEMP TABLE first_proposal AS SELECT value AS proposal FROM jsonb_array_elements(public.match_rules_proposed())
 WHERE value->>'party_id'='ZZTEST-A';
SELECT pg_temp.answer('ZZTEST-A4','ZZTEST-A','overhead');
SELECT pg_temp.check_ok((SELECT proposal=value AND jsonb_array_length(value->'decisions')=3
  AND value->>'party_name'='ZZTEST supplier' AND value->'decisions'->0->>'subject_id'='xero_bill:ZZTEST-A3'
  AND NOT (value->'decisions'->0 ?| ARRAY['before','parts','note'])
  FROM first_proposal,jsonb_array_elements(public.match_rules_proposed()) WHERE value->>'party_id'='ZZTEST-A'),
  'frozen evidence changed');

DO $$ DECLARE r bigint := (SELECT (proposal->>'rule_id')::bigint FROM first_proposal);
 staff uuid := '62000000-0000-4000-8000-000000000001'; stamp timestamptz;
BEGIN
 BEGIN
   PERFORM public.match_rule_confirm(r,true,'62000000-0000-4000-8000-000000000002');
   RAISE EXCEPTION 'trade approved';
 EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.check_ok(SQLERRM='reconcile_not_staff','trade refusal'); END;
 BEGIN
   PERFORM public.match_rule_confirm(r,true,'62000000-0000-4000-8000-000000000003');
   RAISE EXCEPTION 'other org approved';
 EXCEPTION WHEN raise_exception THEN PERFORM pg_temp.check_ok(SQLERRM='match_rule_unavailable','other org refusal'); END;
 PERFORM public.match_rule_confirm(r,true,staff);
 SELECT confirmed_at INTO stamp FROM public.match_rules WHERE id=r;
 PERFORM public.match_rule_confirm(r,true,staff);
 PERFORM pg_temp.check_ok((SELECT status='confirmed' AND confirmed_by='person:'||staff AND confirmed_at=stamp
   FROM public.match_rules WHERE id=r),'confirmation and retry');
 PERFORM pg_temp.answer('ZZTEST-A5','ZZTEST-A','place');
 PERFORM pg_temp.check_ok((SELECT status='confirmed' AND wrong_count=1 FROM public.match_rules WHERE id=r),'first correction');
 PERFORM pg_temp.answer('ZZTEST-A6','ZZTEST-A','place');
 PERFORM pg_temp.check_ok((SELECT status='retired' AND wrong_count=2 FROM public.match_rules WHERE id=r),'second correction');
 BEGIN PERFORM public.match_rule_confirm(r,true,staff); RAISE EXCEPTION 'revived retired rule';
 EXCEPTION WHEN raise_exception THEN PERFORM pg_temp.check_ok(SQLERRM='match_rule_already_decided','retired retry'); END;
END $$;

SELECT pg_temp.answer('ZZTEST-B1','ZZTEST-B','overhead');
SELECT pg_temp.answer('ZZTEST-B2','ZZTEST-B','place');
SELECT pg_temp.answer('ZZTEST-B3','ZZTEST-B','overhead');
SELECT pg_temp.answer('ZZTEST-D1','ZZTEST-D','division_stock','fencing');
SELECT pg_temp.answer('ZZTEST-D2','ZZTEST-D','division_stock','insurance');
SELECT pg_temp.answer('ZZTEST-D3','ZZTEST-D','division_stock','fencing');
SELECT pg_temp.check_ok(NOT EXISTS(SELECT FROM public.match_rules WHERE party_id IN ('ZZTEST-B','ZZTEST-D')),
  'mixed answers proposed a rule');
SELECT pg_temp.answer('ZZTEST-D4','ZZTEST-D','division_stock','fencing');
SELECT pg_temp.answer('ZZTEST-D5','ZZTEST-D','division_stock','fencing');
SELECT pg_temp.check_ok((SELECT division='fencing' AND status='proposed' FROM public.match_rules WHERE party_id='ZZTEST-D'),
  'division streak');
SELECT pg_temp.answer('ZZTEST-D5','ZZTEST-D','undo',NULL,
  (SELECT decision_id FROM public.match_rule_answers WHERE subject_id='xero_bill:ZZTEST-D5'));
DO $$ DECLARE r bigint := (SELECT id FROM public.match_rules WHERE party_id='ZZTEST-D');
BEGIN
 BEGIN PERFORM public.match_rule_confirm(r,true,'62000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'approved undone evidence';
 EXCEPTION WHEN raise_exception THEN PERFORM pg_temp.check_ok(SQLERRM='match_rule_evidence_changed','undo invalidates approval'); END;
 PERFORM public.match_rule_confirm(r,false,'62000000-0000-4000-8000-000000000001');
END $$;
SELECT pg_temp.answer('ZZTEST-U1','ZZTEST-U','overhead');
SELECT pg_temp.answer('ZZTEST-U1','ZZTEST-U','undo',NULL,
  (SELECT decision_id FROM public.match_rule_answers WHERE subject_id='xero_bill:ZZTEST-U1'));
SELECT pg_temp.answer('ZZTEST-U2','ZZTEST-U','overhead');
SELECT pg_temp.answer('ZZTEST-U3','ZZTEST-U','overhead');
SELECT pg_temp.answer('ZZTEST-U4','ZZTEST-U','overhead',NULL,NULL,'legacy:source');
SELECT pg_temp.answer('ZZTEST-U5',NULL,'overhead');
SELECT pg_temp.check_ok(NOT EXISTS(SELECT FROM public.match_rules WHERE party_id='ZZTEST-U'),'undo or legacy counted');
-- Force a read error in the trigger. The decision persists, the proposal does not.
ALTER TABLE public.match_rule_answers RENAME TO zztest_unreadable_answers;
SELECT pg_temp.answer('ZZTEST-U6','ZZTEST-U','overhead');
ALTER TABLE public.zztest_unreadable_answers RENAME TO match_rule_answers;
SELECT pg_temp.check_ok(EXISTS(SELECT FROM public.reconcile_decisions WHERE subject_id='xero_bill:ZZTEST-U6')
 AND NOT EXISTS(SELECT FROM public.match_rules WHERE party_id='ZZTEST-U'),'failed read changed the outcome');

SELECT pg_temp.check_ok(EXISTS(SELECT FROM public.match_rule_retries q JOIN public.reconcile_decisions d
  ON d.id=q.decision_id WHERE d.subject_id='xero_bill:ZZTEST-U6'),'fault was lost');
SELECT pg_temp.answer('ZZTEST-U7','ZZTEST-U','place');
SELECT pg_temp.check_ok(EXISTS(SELECT FROM public.match_rules WHERE party_id='ZZTEST-U' AND status='proposed')
  AND NOT EXISTS(SELECT FROM public.match_rule_retries WHERE org_id='62000000-0000-4000-8000-000000000010'),
  'retry did not recover the original third overhead answer');
SELECT public.match_rule_remove();
SELECT pg_temp.answer('ZZTEST-R1','ZZTEST-R','overhead');
SELECT pg_temp.check_ok(NOT EXISTS(SELECT FROM public.match_rule_answers WHERE subject_id='xero_bill:ZZTEST-R1'),
  'remove did not disable trigger');
SELECT pg_temp.check_ok((public.match_rule_install()->>'installed')::boolean AND
  (SELECT status='retired' AND wrong_count=2 FROM public.match_rules WHERE party_id='ZZTEST-A'),
  'reinstall changed human decision');

-- Representative cardinality, default planner. Exercise the actual lookup and
-- assert the plan reads no more than three history rows without a table scan.
INSERT INTO public.match_rule_answers(org_id,subject_id,party_id,decision_id,decided_at)
 SELECT '62000000-0000-4000-8000-000000000010', 'ZZTEST-P'||i,'ZZTEST-P'||(i%50),-i,now()
 FROM generate_series(1,10000) i;
ANALYZE public.match_rule_answers;
DO $$ DECLARE plan jsonb;
BEGIN
 EXECUTE $query$EXPLAIN (ANALYZE, FORMAT JSON) SELECT decision_id,decided_at FROM public.match_rule_answers
   WHERE org_id='62000000-0000-4000-8000-000000000010' AND party_id='ZZTEST-P1'
   ORDER BY decided_at DESC,decision_id DESC LIMIT 3$query$ INTO plan;
 PERFORM pg_temp.check_ok(plan::text !~ 'Seq Scan|Bitmap Heap Scan' AND plan::text ~ 'Index (Only )?Scan'
   AND (plan#>>'{0,Plan,Plans,0,Actual Rows}')::int=3,'unbounded history lookup');
END $$;
-- Both sides of the actual history/ledger join and the inserted bill's line
-- lookup on representative tables. Extra rows belong to unrelated messages.
SELECT public.match_rule_remove();
INSERT INTO public.reconcile_decisions(org_id,subject_kind,subject_id,action,"by")
 SELECT '62000000-0000-4000-8000-000000000010','message','ZZTEST-M'||i,'message','source:fixture'
 FROM generate_series(1,3000) i;
INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,lane,state,source_hash)
 SELECT '62000000-0000-4000-8000-000000000010','supplier_bill','xero_bill','ZZTEST-P'||i,'1','materials',
   'needs_person','fixture' FROM generate_series(1,3000) i;
ANALYZE public.job_cost_lines;
ANALYZE public.reconcile_decisions;
DO $$ DECLARE plan jsonb;
BEGIN
 EXECUTE $q$EXPLAIN (ANALYZE,FORMAT JSON) SELECT min(party_id),min(party_name) FROM public.job_cost_lines
  WHERE org_id='62000000-0000-4000-8000-000000000010' AND document_kind='xero_bill' AND document_id='ZZTEST-A3'
    AND state IS NOT NULL$q$ INTO plan;
 PERFORM pg_temp.check_ok(plan::text !~ 'Seq Scan' AND plan::text ~ 'Index.*Scan','unbounded document lookup');
 EXECUTE $q$EXPLAIN (ANALYZE,FORMAT JSON) SELECT r.id,r.action,r.parts FROM (
   SELECT a.decision_id FROM public.match_rule_answers a
   WHERE a.org_id='62000000-0000-4000-8000-000000000010' AND a.party_id='ZZTEST-A'
   ORDER BY a.decided_at DESC,a.decision_id DESC LIMIT 3) a
   CROSS JOIN LATERAL (SELECT d.id,d.action,d.parts FROM public.reconcile_decisions d
     WHERE d.id=a.decision_id LIMIT 1) r$q$ INTO plan;
 PERFORM pg_temp.check_ok(plan::text !~ 'Seq Scan' AND regexp_count(plan::text,'Index (Only )?Scan')=2
   AND (plan#>>'{0,Plan,Actual Rows}')::int=3,'unbounded decision lookup');
END $$;
SELECT 'PASS P2-02.12 proposal, evidence, confirmation, corrections, undo, refusal, install and bounded history';
ROLLBACK;
