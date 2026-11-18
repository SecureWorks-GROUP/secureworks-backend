\set ON_ERROR_STOP on
BEGIN;
\ir ../../../migrations/20261118123715_job_cost_proven_share.sql
SET LOCAL statement_timeout='120s';

CREATE FUNCTION pg_temp.check_share(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'share_contract: %',label; END IF;
END $$;
SELECT pg_temp.check_share(
  NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.reconcile_items'::regclass AND tgname='job_profit_reconcile_item_changed')
  AND md5(prosrc)='5bf1ad820296062f851290ae4d750426','inert migration')
FROM pg_proc WHERE oid='public.job_profit_refresh_many(uuid[])'::regprocedure;
SELECT pg_temp.check_share(has_function_privilege('service_role','public.job_cost_proven_share(uuid[])','execute')
  AND NOT has_function_privilege('authenticated','public.job_cost_proven_share(uuid[])','execute')
  AND NOT has_function_privilege('anon','public.job_cost_proven_share(uuid[])','execute')
  AND NOT has_function_privilege('service_role','public.job_profit_install_proven_share()','execute'),'service and director boundaries');

CREATE FUNCTION pg_temp.j(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('ZZTEST-share-job-'||n)::uuid $$;
CREATE FUNCTION pg_temp.l(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('ZZTEST-share-line-'||n)::uuid $$;
INSERT INTO public.organisations(id,name) VALUES(pg_temp.j(0),'ZZTEST');
INSERT INTO public.jobs(id,org_id,type,status,job_number,metadata,pricing_json,created_at)
  SELECT pg_temp.j(n),pg_temp.j(0),'fencing','complete','ZZTEST-SHARE-'||n,'{}','{}','2026-06-01'
  FROM generate_series(1,6) n;
CREATE FUNCTION pg_temp.add_line(n int,j int,doc text,amount numeric,who text,kind text DEFAULT 'xero_bill')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,line_no,lane,
    amount_ex,state,decided_by_kind,source_hash)
  VALUES(pg_temp.l(n),pg_temp.j(0),CASE kind WHEN 'xero_credit_note' THEN 'supplier_credit' WHEN 'trade_invoice'
    THEN 'trade_line' ELSE 'supplier_bill' END,kind,doc,'line-'||n,n,'materials',amount,
    CASE WHEN j IS NULL THEN 'needs_person' ELSE 'on_job' END,who,'ZZTEST');
  IF j IS NOT NULL THEN
    INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
    VALUES(pg_temp.l(n),1,'job',pg_temp.j(j),'materials',amount);
  END IF;
END $$;
SELECT pg_temp.add_line(1,1,'person',1000,'person');
SELECT pg_temp.add_line(2,1,'keys',500,'matcher');
SELECT pg_temp.add_line(3,1,'mixed',300,'matcher');
SELECT pg_temp.add_line(4,1,'legacy',200,'legacy');
SELECT pg_temp.add_line(5,NULL,'pending:document',400,'legacy');
SELECT pg_temp.add_line(6,2,'small',100,'person');
SELECT pg_temp.add_line(7,NULL,'open-credit',-99,'source','xero_credit_note');
SELECT pg_temp.add_line(8,NULL,'no-amount',NULL,'legacy');
SELECT pg_temp.add_line(9,5,'trade',7,'source','trade_invoice');

INSERT INTO public.match_clues(org_id,subject_kind,subject_id,run_id,clue_code,class,family,root,outcome,job_id,names_one,rule_version)
  SELECT pg_temp.j(0),'cost_document','xero_bill:'||doc,pg_temp.j(0),code,class,'test',code,'job',pg_temp.j(1),true,'v1'
  FROM (VALUES ('keys','job_number','key'),('keys','order_number','key'),('mixed','job_number','key'),('mixed','order_amount','clue')) v(doc,code,class);
WITH decisions AS (
  INSERT INTO public.reconcile_decisions(org_id,subject_kind,subject_id,action,clue_ids,"by")
    SELECT org_id,subject_kind,subject_id,'place',array_agg(id ORDER BY id),'matcher:v1' FROM public.match_clues
    WHERE org_id=pg_temp.j(0) GROUP BY org_id,subject_kind,subject_id
  RETURNING id,subject_id
) UPDATE public.job_cost_lines l SET decision_id=d.id FROM decisions d
  WHERE l.org_id=pg_temp.j(0) AND d.subject_id=l.document_kind||':'||l.document_id;
CREATE FUNCTION pg_temp.raise_item(doc text,j int,kind text) RETURNS uuid LANGUAGE sql AS $$
  SELECT public.reconcile_item_raise(kind,'cost_document',doc,ARRAY[pg_temp.j(j)],NULL,'{"reason":"needs_person"}','contract')
$$;
SELECT pg_temp.raise_item('xero_bill:pending:document',1,'bill');
SELECT pg_temp.raise_item('xero_credit_note:open-credit',2,'credit');
SELECT pg_temp.raise_item('xero_bill:no-amount',4,'bill');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SELECT pg_temp.check_share((cost_proven_ex,cost_on_clues_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct)
  IS NOT DISTINCT FROM (1500::numeric,500::numeric,400::numeric,1,62.50::numeric),'normal') FROM public.job_cost_proven_share(ARRAY[pg_temp.j(1)]);
SELECT pg_temp.check_share((cost_proven_ex,cost_unknown_ex,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (100::numeric,-99::numeric,NULL::numeric,'share_unknown_credit_open'::text),'open credit')
  FROM public.job_cost_proven_share(ARRAY[pg_temp.j(2)]);
SELECT pg_temp.check_share(proven_share_pct IS NULL AND proven_share_reason='share_unknown_credit_open','zero denominator')
  FROM public.job_cost_proven_share(ARRAY[pg_temp.j(3)]);
SELECT pg_temp.check_share(cost_unknown_items=1 AND cost_unknown_ex IS NULL AND proven_share_pct IS NULL,'unpriced')
  FROM public.job_cost_proven_share(ARRAY[pg_temp.j(4)]);
SELECT pg_temp.check_share(cost_proven_ex=7 AND proven_share_pct=100,'source') FROM public.job_cost_proven_share(ARRAY[pg_temp.j(5)]);
SELECT pg_temp.check_share(NOT EXISTS(SELECT FROM public.job_cost_proven_share(ARRAY[pg_temp.j(-1)])),'missing job');

-- Two item kinds can refer to the same needs-person line.
SAVEPOINT duplicate_item;
SELECT pg_temp.raise_item('xero_bill:pending:document',1,'open_item_check');
SELECT pg_temp.check_share(cost_unknown_items=2 AND cost_unknown_ex=400,'deduplicated amount')
  FROM public.job_cost_proven_share(ARRAY[pg_temp.j(1)]);
ROLLBACK TO duplicate_item;
SAVEPOINT follows;
SELECT pg_temp.add_line(10,1,'credit',-100,'source','xero_credit_note');
UPDATE public.job_cost_lines SET follows_line_id=pg_temp.l(1) WHERE id=pg_temp.l(10);
SELECT pg_temp.check_share(cost_proven_ex=1400 AND cost_on_clues_ex=500,'line follower')
  FROM public.job_cost_proven_share(ARRAY[pg_temp.j(1)]);
UPDATE public.job_cost_lines SET follows_line_id=NULL,follows_document_kind='xero_bill',follows_document_id='legacy' WHERE id=pg_temp.l(10);
SELECT pg_temp.check_share(cost_proven_ex=1500 AND cost_on_clues_ex=400,'document follower')
  FROM public.job_cost_proven_share(ARRAY[pg_temp.j(1)]);
-- One credit on a multi-line bill inherits each parent's decision, even
-- when both allocations land on the same job.
SELECT pg_temp.add_line(11,1,'both',50,'person');
SELECT pg_temp.add_line(12,1,'both',50,'legacy');
INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,lane,amount_ex,
  state,decided_by_kind,source_hash,follows_document_kind,follows_document_id)
  VALUES(pg_temp.l(13),pg_temp.j(0),'supplier_credit','xero_credit_note','both-credit','one','materials',-20,
    'split','source','test','xero_bill','both');
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
  SELECT pg_temp.l(13),n,'job',pg_temp.j(1),'materials',-10 FROM generate_series(1,2) n;
SELECT pg_temp.check_share(cost_proven_ex=1540 AND cost_on_clues_ex=440,'mixed-document credit')
  FROM public.job_cost_proven_share(ARRAY[pg_temp.j(1)]);

ROLLBACK TO follows;

-- A representative background population keeps an empty test table from
-- making a full scan look cheaper than the production access pattern.
SAVEPOINT indexed_reads;
INSERT INTO public.jobs(id,org_id,type,status,job_number)
  SELECT pg_temp.j(n),pg_temp.j(0),'fencing','complete','ZZTEST-PLAN-'||n FROM generate_series(100,3099) n;
INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,decided_by_kind,source_hash)
  SELECT pg_temp.l(n),pg_temp.j(0),'supplier_bill','xero_bill','plan-'||n,'one','materials',1,
    CASE WHEN n%2=0 THEN 'on_job' ELSE 'needs_person' END,'legacy','ZZTEST' FROM generate_series(100,3099) n;
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
  SELECT pg_temp.l(n),1,'job',pg_temp.j(n),'materials',1 FROM generate_series(100,3098,2) n;
INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,job_ids,reason,evidence_hash,raised_by)
  SELECT pg_temp.j(0),'bill','cost_document','xero_bill:plan-'||n,ARRAY[pg_temp.j(n)],'needs_person','test','contract'
  FROM generate_series(101,3099,2) n;
ANALYZE public.jobs;
ANALYZE public.job_cost_lines;
ANALYZE public.job_cost_line_parts;
ANALYZE public.reconcile_items;
DO $plan$ DECLARE q text; plan jsonb; rel text;
BEGIN
  SELECT prosrc INTO q FROM pg_proc WHERE oid='public.job_cost_proven_share(uuid[])'::regprocedure;
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) '||replace(q,'p_job_ids',format('ARRAY[%L::uuid]',pg_temp.j(1))) INTO plan;
  FOREACH rel IN ARRAY ARRAY['jobs','job_cost_lines','job_cost_line_parts','reconcile_items'] LOOP
    IF jsonb_path_exists(plan,'$.** ? (@."Relation Name" == $rel && @."Node Type" == "Seq Scan")',jsonb_build_object('rel',rel))
      OR NOT jsonb_path_exists(plan,'$.** ? (@."Relation Name" == $rel && (@."Node Type" == "Index Scan" || @."Node Type" == "Bitmap Heap Scan" || @."Node Type" == "Index Only Scan"))',jsonb_build_object('rel',rel))
      OR jsonb_path_exists(plan,'$.** ? (@."Relation Name" == $rel && @."Actual Rows" > 10)',jsonb_build_object('rel',rel))
    THEN RAISE EXCEPTION 'share_unbounded_plan %',rel; END IF;
  END LOOP;
END $plan$;
ROLLBACK TO indexed_reads;


SELECT public.job_profit_install_proven_share();
SELECT public.job_profit_install_proven_share();
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_profit_refresh_v1';
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh_many(ARRAY[pg_temp.j(1),pg_temp.j(2),pg_temp.j(3),pg_temp.j(4),pg_temp.j(5)]);
SELECT pg_temp.check_share((SELECT count(*) FROM public.job_profit_stored WHERE job_id=ANY(ARRAY[pg_temp.j(1),pg_temp.j(2),pg_temp.j(3)]))=3
 AND (SELECT proven_share_pct FROM public.job_profit_stored WHERE job_id=pg_temp.j(1))=62.50
 AND (SELECT count(*) FROM public.job_profit_stored WHERE job_id=ANY(ARRAY[pg_temp.j(2),pg_temp.j(3)])
      AND proven_share_pct IS NULL AND proven_share_reason='share_unknown_credit_open')=2,'mixed refresh stored');
SELECT pg_temp.check_share((SELECT count(*) FROM public.reconcile_items WHERE kind='job_cost_share' AND status='open'
  AND job_ids && ARRAY[pg_temp.j(2),pg_temp.j(3)] AND reason='share_unknown_credit_open')=2,'two human reviews');
SET LOCAL statement_timeout='120s';
SELECT pg_temp.check_share((public.job_profit_refresh_many(ARRAY[pg_temp.j(1),pg_temp.j(2),pg_temp.j(3)])->>'changed')::int=0,'idempotent refresh');
SELECT pg_temp.check_share((SELECT count(*) FROM public.reconcile_items WHERE kind='job_cost_share'
  AND job_ids && ARRAY[pg_temp.j(2),pg_temp.j(3)])=2,'idempotent review');
SELECT pg_temp.check_share((public.job_profit_stored_compare(ARRAY[pg_temp.j(1),pg_temp.j(2)]) -> 'differences')='[]','view parity');

-- Moving the item enqueues each distinct old/new job once. Closing it marks the remaining job.
CREATE TEMP TABLE event_floor AS SELECT coalesce(max(id),0) AS id FROM public.job_profit_change_events;
UPDATE public.reconcile_items SET job_ids=ARRAY[pg_temp.j(6),pg_temp.j(6)] WHERE subject_id='xero_credit_note:open-credit';
SELECT pg_temp.check_share((SELECT array_agg(job_id ORDER BY job_id) FROM public.job_profit_change_events
  WHERE id>(SELECT id FROM event_floor) AND reason='reconcile_item')=
  (SELECT array_agg(id ORDER BY id) FROM unnest(ARRAY[pg_temp.j(2),pg_temp.j(6)]) id),'old and new jobs');
SELECT public.reconcile_item_withdraw('credit','cost_document','xero_credit_note:open-credit','fixed_by_office');
SET LOCAL statement_timeout='120s';
SELECT pg_temp.check_share((public.job_profit_refresh_many(ARRAY[pg_temp.j(2)])->>'changed')::int=1,'share alone changes profit');
SELECT pg_temp.check_share((SELECT proven_share_pct=100 AND proven_share_reason IS NULL FROM public.job_profit_stored WHERE job_id=pg_temp.j(2))
  AND EXISTS(SELECT FROM public.reconcile_items WHERE kind='job_cost_share' AND subject_id=pg_temp.j(2)::text AND status='withdrawn'),'corrected share and closed review');

SAVEPOINT read_fault;
ALTER TABLE public.match_clues RENAME TO zztest_share_clues_unavailable;
DO $$ BEGIN
  PERFORM * FROM public.job_cost_proven_share(ARRAY[pg_temp.j(1)]);
  RAISE EXCEPTION 'read failure returned a measurement';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
ROLLBACK TO read_fault;
SELECT pg_temp.check_share((SELECT proven_share_pct FROM public.job_cost_proven_share(ARRAY[pg_temp.j(1)]))=62.50,'retry after read fault');
SELECT public.job_profit_remove_proven_share();
SELECT pg_temp.check_share(
  (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_profit_refresh_many(uuid[])'::regprocedure)='5bf1ad820296062f851290ae4d750426'
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_profit_mark(uuid,text)'::regprocedure)='3f3c3d56c36b1721a3c7f808ccfac958'
  AND NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.reconcile_items'::regclass AND tgname='job_profit_reconcile_item_changed'),'removed');
ROLLBACK;
\echo PASS P2-13.2 proven share, credit review, zero denominator, mixed batch, retries and director install
