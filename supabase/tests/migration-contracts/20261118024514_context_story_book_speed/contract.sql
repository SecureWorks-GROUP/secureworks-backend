
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL jit=off;
SET LOCAL TimeZone='UTC';
SET LOCAL statement_timeout='120s';
-- Rule 17: recreate this case's own objects after predecessor rollback proofs.
\ir ../../../migrations/20261118024514_context_story_book_speed.sql
CREATE FUNCTION pg_temp.bs_assert(ok boolean,msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FU26.0: %',msg; END IF; END $f$;
SELECT pg_temp.bs_assert((SELECT md5(prosrc)='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure),'merge changed main book');
SELECT pg_temp.bs_assert((SELECT md5(prosrc)='ac51513f6164fa256011d67c1bd82b10' FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure),'merge changed text get');
\ir fixtures.sql
\ir ../20261029170000_cfo_bill_cost_outcomes/h7_fixtures.sql
CREATE TEMP TABLE bs_jobs AS SELECT id FROM public.jobs WHERE job_number LIKE 'TP13-%' OR job_number IN ('MB-1','MB-2') OR job_number LIKE 'H7-J%';
DO $all_fixtures$ DECLARE j uuid; n integer:=0; BEGIN
 FOR j IN SELECT id FROM bs_jobs LOOP
  PERFORM pg_temp.bs_assert(public.context_job_story_book_fast(j) IS NOT DISTINCT FROM public.context_job_story_book(j),'complete book differs for '||j);
  PERFORM pg_temp.bs_assert(NOT EXISTS(
   (SELECT party,amount_ex FROM public.context_story_book_costs(j) WHERE source='trade_line' AND is_actual
    EXCEPT ALL SELECT party,amount_ex FROM public.v_job_cost_events WHERE job_id=j AND source='trade_line' AND is_actual)
   UNION ALL
   (SELECT party,amount_ex FROM public.v_job_cost_events WHERE job_id=j AND source='trade_line' AND is_actual
    EXCEPT ALL SELECT party,amount_ex FROM public.context_story_book_costs(j) WHERE source='trade_line' AND is_actual)
  ),'bounded crew source differs');
  PERFORM pg_temp.bs_assert((SELECT count(*) FROM public.context_story_book_costs(j) WHERE source='po_committed')=
   (SELECT count(*) FROM public.v_job_cost_events WHERE job_id=j AND source='po_committed'),'bounded orders differ');
  n:=n+1;
 END LOOP;
 PERFORM pg_temp.bs_assert(n=27,'existing fixture cohort missing');
 RAISE NOTICE 'FU26.0 complete book equality: % existing fixtures passed',n;
END $all_fixtures$;

SAVEPOINT resolver_cases;
INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,pricing_json,created_at)
VALUES('f0260000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','in_progress','fencing','SWF-900001','{}','{}','2026-07-01');
INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,job_number,line_type,description,line_total_ex)
SELECT '5eb30000-0000-4000-8000-000000000001',
 CASE WHEN n IN(1,2,3,4,5) THEN NULL WHEN n=6 THEN '5eb00000-0000-4000-8000-000000000001'::uuid ELSE 'f0260000-0000-4000-8000-000000000001'::uuid END,
 CASE WHEN n IN(1,3,6,7) THEN ' SWF-900001 ' END,
 'labour',CASE WHEN n IN(2,3) THEN 'Work SWF-900001' WHEN n=4 THEN 'QA TEST SWF-900001' WHEN n=5 THEN 'Commission advance SWF-900001' ELSE 'ZZTEST work' END,10
FROM generate_series(1,7) n;
DO $resolver$ DECLARE j uuid:='f0260000-0000-4000-8000-000000000001'; BEGIN
 PERFORM pg_temp.bs_assert((SELECT count(*) FROM public.context_story_book_costs(j) WHERE source='trade_line')=4,'resolver direct/number/description overlap, exclusion or direct precedence');
 PERFORM pg_temp.bs_assert(public.context_job_story_book_fast(j)=public.context_job_story_book_main(j),'resolver cases changed the book');
 UPDATE public.trade_invoices SET status='draft' WHERE id='5eb30000-0000-4000-8000-000000000001';
 PERFORM pg_temp.bs_assert(NOT EXISTS(SELECT 1 FROM public.context_story_book_costs(j)) AND public.context_job_story_book_fast(j)=public.context_job_story_book_main(j),'draft crew changed');
 UPDATE public.trade_invoices SET status='paid',xero_bill_status='VOIDED' WHERE id='5eb30000-0000-4000-8000-000000000001';
 PERFORM pg_temp.bs_assert(NOT EXISTS(SELECT 1 FROM public.context_story_book_costs(j)) AND public.context_job_story_book_fast(j)=public.context_job_story_book_main(j),'void crew changed');
END $resolver$;
ROLLBACK TO resolver_cases;

-- Capture the real front door for every fixture, including a card supplied by
-- the caller, no story, fresh, stale, unchecked, and a card of another job.
CREATE TEMP TABLE bs_before(job_id uuid,kind text,answer jsonb,PRIMARY KEY(job_id,kind));
INSERT INTO bs_before SELECT id,'none',public.context_job_story_text_get(id,public.context_job_story(id,now()),true) FROM bs_jobs;
INSERT INTO public.context_job_story_texts(job_id,checked_at,job_status,card_hash,model,sections,checks,written_at)
SELECT j.id,now(),c#>>'{job,status}',public.context_job_story_full_hash(c),'test',
 '{"headline":"h","the_job":"j","how_we_got_here":"h","where_it_is_at":"w","watch_out":"None."}'::jsonb,'{}',now()
FROM bs_jobs j CROSS JOIN LATERAL (SELECT public.context_job_story_writer_input(j.id)->'card' c) x;
INSERT INTO bs_before SELECT id,'fresh',public.context_job_story_text_get(id,public.context_job_story(id,now()),true) FROM bs_jobs;
INSERT INTO bs_before SELECT id,'unchecked',public.context_job_story_text_get(id,NULL,false) FROM bs_jobs;
INSERT INTO bs_before SELECT id,'wrong_card',public.context_job_story_text_get(id,'{"job":{"id":"00000000-0000-4000-8000-000000009999"}}',true) FROM bs_jobs;
INSERT INTO bs_before SELECT id,'writer_card',public.context_job_story_text_get(id,public.context_job_story_writer_input(id)->'card',true) FROM bs_jobs;
SELECT public.install_context_story_book_speed();
SELECT public.install_context_story_book_speed();
\ir ../../../migrations/20261118024514_context_story_book_speed.sql
DO $front_door$ DECLARE r record; got jsonb; BEGIN
 FOR r IN SELECT * FROM bs_before LOOP
  got:=CASE r.kind
   WHEN 'none' THEN NULL -- checked below by temporarily setting the text aside
   WHEN 'unchecked' THEN public.context_job_story_text_get(r.job_id,NULL,false)
   WHEN 'wrong_card' THEN public.context_job_story_text_get(r.job_id,'{"job":{"id":"00000000-0000-4000-8000-000000009999"}}',true)
   WHEN 'writer_card' THEN public.context_job_story_text_get(r.job_id,public.context_job_story_writer_input(r.job_id)->'card',true)
   ELSE public.context_job_story_text_get(r.job_id,public.context_job_story(r.job_id,now()),true) END;
  IF r.kind<>'none' THEN PERFORM pg_temp.bs_assert(got IS NOT DISTINCT FROM r.answer,'front door differs: '||r.kind||' '||r.job_id); END IF;
 END LOOP;
END $front_door$;
SAVEPOINT no_text;
DELETE FROM public.context_job_story_texts WHERE job_id IN (SELECT id FROM bs_jobs);
SELECT pg_temp.bs_assert(NOT EXISTS(SELECT 1 FROM bs_before b WHERE kind='none' AND b.answer IS DISTINCT FROM public.context_job_story_text_get(b.job_id,public.context_job_story(b.job_id,now()),true)),'no-story answer changed');
ROLLBACK TO no_text;
SELECT public.remove_context_story_book_speed();
-- A hand edit changes the current words; old text must be stale in both paths.
UPDATE public.trade_invoice_lines SET line_total_ex=line_total_ex+1 WHERE job_id='5eb00000-0000-4000-8000-000000000001';
INSERT INTO bs_before SELECT id,'stale',public.context_job_story_text_get(id,public.context_job_story(id,now()),true) FROM bs_jobs;
SELECT pg_temp.bs_assert((SELECT answer->>'status'='stale' FROM bs_before WHERE job_id='5eb00000-0000-4000-8000-000000000001' AND kind='stale'),'fixture hand edit did not make text stale');
SELECT public.install_context_story_book_speed();
SELECT pg_temp.bs_assert(NOT EXISTS(SELECT 1 FROM bs_before b WHERE kind='stale' AND b.answer IS DISTINCT FROM public.context_job_story_text_get(b.job_id,public.context_job_story(b.job_id,now()),true)),'stale status or money changed');
SELECT pg_temp.bs_assert(public.context_job_story_book(NULL) IS NULL AND public.context_job_story_book('00000000-0000-4000-8000-000000009999') IS NULL,'missing job changed');
-- A read refusal and a later source change both return main's current answer,
-- never yesterday's money. Retrying after repair uses the bounded path again.
SAVEPOINT read_failure;
CREATE OR REPLACE FUNCTION public.context_story_book_costs(p_job_id uuid)
RETURNS TABLE(party text,amount_ex numeric,source text,is_actual boolean)
LANGUAGE plpgsql STABLE AS $f$ BEGIN RAISE EXCEPTION 'injected read failure'; END $f$;
SELECT pg_temp.bs_assert(public.context_job_story_book('5eb00000-0000-4000-8000-000000000001')=public.context_job_story_book_main('5eb00000-0000-4000-8000-000000000001'),'failed read did not fall back');
ROLLBACK TO read_failure;
SAVEPOINT changed_source;
DO $source$ DECLARE d text:=pg_get_viewdef('public.v_trade_charge_resolved'::regclass,true); BEGIN EXECUTE 'CREATE OR REPLACE VIEW public.v_trade_charge_resolved AS SELECT * FROM ('||rtrim(d,E';\n ')||') r WHERE true'; END $source$;
SELECT pg_temp.bs_assert(public.context_job_story_book('5eb00000-0000-4000-8000-000000000001')=public.context_job_story_book_main('5eb00000-0000-4000-8000-000000000001'),'source drift fallback differs');
ROLLBACK TO changed_source;
SELECT pg_temp.bs_assert(public.context_job_story_book('5eb00000-0000-4000-8000-000000000001')=public.context_job_story_book_main('5eb00000-0000-4000-8000-000000000001'),'retry after refusal differs');
SELECT public.remove_context_story_book_speed();
SELECT pg_temp.bs_assert((SELECT md5(prosrc)='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure),'remove did not restore exact main');
-- Rule 16: dense unrelated rows make accidental whole-company scans visible.
SAVEPOINT plan_rows;
SET LOCAL session_replication_role=replica; -- Plan-only population, no business flow is claimed.
INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,pricing_json,created_at)
SELECT md5('bs-job-'||n)::uuid,'00000000-0000-0000-0000-000000000001','in_progress','fencing','ZZTEST-BS-'||n,'{}','{}','2026-07-01' FROM generate_series(1,10000) n;
INSERT INTO public.users(id,org_id,name) SELECT md5('bs-user-'||n)::uuid,'00000000-0000-0000-0000-000000000001','ZZTEST crew' FROM generate_series(1,10000) n;
INSERT INTO public.trade_invoices(id,org_id,user_id,week_start,status,subtotal_ex,invoice_number)
SELECT md5('bs-invoice-'||n)::uuid,'00000000-0000-0000-0000-000000000001',md5('bs-user-'||n)::uuid,'2026-08-03','paid',10,'ZZTEST-BS-'||n FROM generate_series(1,10000) n;
INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,line_total_ex)
SELECT md5('bs-invoice-'||n)::uuid,md5('bs-job-'||n)::uuid,'labour','ZZTEST work',10 FROM generate_series(1,10000) n;
INSERT INTO public.purchase_orders(id,job_id,po_number,status,subtotal)
SELECT md5('bs-po-'||n)::uuid,md5('bs-job-'||n)::uuid,'ZZTEST-BS-'||n,'sent',10 FROM generate_series(1,10000) n;
INSERT INTO public.job_materials_facts(job_id,matched_po_id,xero_invoice_id,kind,lane,amount_ex_gst,confidence,automation_source)
SELECT md5('bs-job-'||n)::uuid,md5('bs-po-'||n)::uuid,'bs-fact-'||n,'actual','materials',10,'high','manual_queue' FROM generate_series(1,10000) n;
SET LOCAL session_replication_role=origin;
ANALYZE public.jobs; ANALYZE public.users; ANALYZE public.trade_invoices; ANALYZE public.trade_invoice_lines; ANALYZE public.purchase_orders; ANALYZE public.job_materials_facts;
DO $plans$ DECLARE src text; q text; p jsonb; node jsonb; k integer; BEGIN
 SELECT prosrc INTO src FROM pg_proc WHERE oid='public.context_story_book_costs(uuid)'::regprocedure;
 src:=regexp_replace(src,E'--[^\\n]*','','g');
 FOR k IN 2..3 LOOP
  q:=split_part(split_part(src,'RETURN QUERY',k),';',1);
  q:=replace(q,'p_job_id',quote_literal('5eb00000-0000-4000-8000-000000000001')||'::uuid');
  EXECUTE 'EXPLAIN(ANALYZE,FORMAT JSON,TIMING OFF) '||q INTO p;
  PERFORM pg_temp.bs_assert(NOT jsonb_path_exists(p,'$.** ? (@."Node Type" == "Seq Scan" && (@."Relation Name" == "jobs" || @."Relation Name" == "trade_invoice_lines" || @."Relation Name" == "trade_invoices" || @."Relation Name" == "purchase_orders" || @."Relation Name" == "job_materials_facts"))'),'unbounded big-table scan: '||p::text);
  PERFORM pg_temp.bs_assert(jsonb_path_exists(p,'$.** ? (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || @."Node Type" == "Bitmap Index Scan")'),'no index scan');
  FOR node IN SELECT value FROM jsonb_path_query(p,'$.** ? (@."Relation Name" == "jobs" || @."Relation Name" == "trade_invoice_lines" || @."Relation Name" == "trade_invoices" || @."Relation Name" == "purchase_orders" || @."Relation Name" == "job_materials_facts")') AS nodes(value) LOOP
   PERFORM pg_temp.bs_assert(coalesce((node->>'Actual Rows')::numeric,0)+coalesce((node->>'Rows Removed by Filter')::numeric,0)<=16,'read grew with company: '||node::text);
  END LOOP;
  RAISE NOTICE 'FU26.0 bounded query % plan: %',k-1,p;
 END LOOP;
END $plans$;
ROLLBACK TO plan_rows;
-- No public helper door or new writer exists.
DO $privileges$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['context_story_book_costs(uuid)','context_job_story_book_main(uuid,timestamptz)','context_job_story_book_fast(uuid,timestamptz)','install_context_story_book_speed()','remove_context_story_book_speed()'] LOOP
  PERFORM pg_temp.bs_assert(NOT has_function_privilege('anon','public.'||f,'EXECUTE') AND NOT has_function_privilege('authenticated','public.'||f,'EXECUTE'),'public helper privilege: '||f);
 END LOOP;
END $privileges$;
ROLLBACK;
\echo FU26.0 PASS: full-book and front-door fixture parity, fallback, retry, installer, privileges, 2 native indexed plans
