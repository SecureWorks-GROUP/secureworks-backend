BEGIN;
SET LOCAL statement_timeout='120s';
SET LOCAL TimeZone='UTC';
-- Rule 17: protect this contract from prerequisite objects removed by another
-- case, without repairing the deliberately corrupted body in the break proof.
SELECT to_regclass('public.job_profit_stored') IS NULL
 OR to_regclass('public.job_cost_events_stored') IS NULL
 OR to_regclass('public.job_revenue_events_stored') IS NULL
 OR to_regclass('public.job_profit_dirty') IS NULL
 OR to_regprocedure('public.job_profit_refresh(uuid)') IS NULL
 OR to_regprocedure('public.job_profit_refresh_all()') IS NULL
 OR to_regprocedure('public.job_profit_refresh_many(uuid[])') IS NULL AS restore_stored_prerequisite \gset
\if :restore_stored_prerequisite
\ir ../../../migrations/20261117195801_job_profit_stored.sql
\endif
SELECT :'restore_stored_prerequisite'::boolean OR to_regprocedure('public.job_profit_refresh_all(uuid,integer)') IS NULL AS restore_batch_prerequisite \gset
\if :restore_batch_prerequisite
\ir ../../../migrations/20261117220001_job_profit_refresh_batches.sql
\endif
-- No view stand-ins: exercise every real Job Profit column on the full engine.
INSERT INTO public.organisations(id,name) VALUES('f0210000-0000-4000-8000-000000000001','ZZTEST organisation');
INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,pricing_json,created_at)
SELECT ('f0210000-0000-4000-8000-00000000000'||n)::uuid,
 'f0210000-0000-4000-8000-000000000001','complete','fencing','ZZTEST-FU21-'||n,'{}','{}','2026-06-01'
FROM generate_series(1,3) n;
-- Rule 16: prove the two refill ranges use an index in a native plan, with
-- no enable_seqscan override. The plan-only population rolls back before money.
SAVEPOINT plan_population;
INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,pricing_json,created_at)
SELECT gen_random_uuid(),'f0210000-0000-4000-8000-000000000001','complete','fencing',
 'ZZTEST-FU21-PLAN-'||n,'{}','{}','2026-06-01'
FROM generate_series(1,10000) n;
ANALYZE public.jobs;
DO $plans$ DECLARE p jsonb; q text; BEGIN
 FOREACH q IN ARRAY ARRAY[
  'SELECT id FROM public.jobs ORDER BY id LIMIT 501',
  'SELECT id FROM public.jobs WHERE id>''f020ffff-ffff-ffff-ffff-ffffffffffff''::uuid ORDER BY id LIMIT 501'
 ] LOOP
  EXECUTE 'EXPLAIN (FORMAT JSON) '||q INTO p;
  IF p::text LIKE '%Seq Scan%' OR NOT (p::text LIKE '%Index Only Scan%' OR p::text LIKE '%Index Scan%') THEN
   RAISE EXCEPTION 'FU21 keyset is not served by an index: %',p; END IF;
  RAISE NOTICE 'FU21 keyset plan: %',p;
 END LOOP;
END $plans$;
ROLLBACK TO plan_population;
-- 1: a bill credited in Xero; 2: an unverified cost; 3: no cost at all.
INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,contact_name,
 sub_total,total,invoice_date,job_id,reference,raw_json,line_items)
SELECT 'f0210000-0000-4000-8000-000000000001','fu21-invoice-'||n,'ZZTEST-INV-'||n,'ACCREC','AUTHORISED','ZZTEST customer',
 200,220,'2026-08-03',('f0210000-0000-4000-8000-00000000000'||n)::uuid,'ZZTEST-FU21-'||n,CASE WHEN n=1 THEN '{"AmountCredited":22}'::jsonb ELSE '{}'::jsonb END,
 jsonb_build_array(jsonb_build_object('LineItemID','fu21-revenue-'||n,'Description','Fence','LineAmount',200,'AccountCode','207'))
FROM generate_series(1,3) n;
INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,contact_name,
 sub_total,total,invoice_date,job_id,raw_json,line_items)
SELECT 'f0210000-0000-4000-8000-000000000001','fu21-bill-'||n,'ZZTEST-BILL-'||n,'ACCPAY','PAID','ZZTEST supplier',
 100,110,'2026-08-04',('f0210000-0000-4000-8000-00000000000'||n)::uuid,
 CASE WHEN n=1 THEN '{"AmountCredited":11,"LineAmountTypes":"Exclusive"}'::jsonb ELSE '{"LineAmountTypes":"Exclusive"}'::jsonb END,
 jsonb_build_array(jsonb_build_object('LineItemID','fu21-cost-'||n,'Description','Panels','LineAmount',100,'TaxAmount',10,'AccountCode','310'))
FROM generate_series(1,2) n;
-- Record complete legacy rows before using the stored path. Every column must agree.
CREATE TEMP TABLE fu21_expected AS SELECT * FROM public.v_job_profit WHERE job_number LIKE 'ZZTEST-FU21-%';
DO $cases$ BEGIN
 IF (SELECT count(*) FROM fu21_expected)<>3 THEN RAISE EXCEPTION 'FU21 three real jobs missing'; END IF;
 IF (SELECT actual_cost_ex FROM fu21_expected WHERE job_number='ZZTEST-FU21-1') IS DISTINCT FROM 90::numeric
  OR NOT EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE job_id='f0210000-0000-4000-8000-000000000001' AND amount_ex<0) THEN
  RAISE EXCEPTION 'FU21 credited bill fixture is not a credit'; END IF;
 IF (SELECT invoiced_ex FROM fu21_expected WHERE job_number='ZZTEST-FU21-1') IS DISTINCT FROM 180::numeric
  OR NOT EXISTS(SELECT 1 FROM public.v_job_revenue_events WHERE job_id='f0210000-0000-4000-8000-000000000001' AND kind='credit_applied' AND amount_ex=-20) THEN
  RAISE EXCEPTION 'FU21 customer credit fixture is not a credit'; END IF;
 IF (SELECT result->>'status' FROM public.job_profit_line_evidence_many(ARRAY['f0210000-0000-4000-8000-000000000002']::uuid[]))='verified' THEN
  RAISE EXCEPTION 'FU21 unverified fixture unexpectedly verified'; END IF;
 IF EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE job_id='f0210000-0000-4000-8000-000000000003') THEN
  RAISE EXCEPTION 'FU21 no-cost fixture has cost'; END IF;
END $cases$;
SELECT public.job_profit_refresh_many(ARRAY(SELECT job_id FROM fu21_expected));
DO $equal$ BEGIN
 IF EXISTS(SELECT 1 FROM fu21_expected e FULL JOIN
  (SELECT * FROM public.job_profit_stored WHERE job_number LIKE 'ZZTEST-FU21-%') s USING(job_id)
  WHERE to_jsonb(e) IS DISTINCT FROM to_jsonb(s)-'computed_at') THEN
  RAISE EXCEPTION 'FU21 real credit/unverified/no-cost rows differ'; END IF;
 IF EXISTS(SELECT 1 FROM public.job_profit_stored WHERE job_number='ZZTEST-FU21-3' AND actual_cost_ex IS DISTINCT FROM 0::numeric) THEN
  RAISE EXCEPTION 'FU21 no-cost row changed'; END IF;
END $equal$;
-- Observe real event rows inside MATERIALIZED CTEs, so count(*) and SELECT *
-- cannot evaluate volatile counters at different filter points. Money is unchanged.
CREATE SEQUENCE public.fu21_cost_reads;
CREATE FUNCTION public.fu21_observe_cost() RETURNS boolean LANGUAGE plpgsql AS $f$
/* function block */ BEGIN PERFORM nextval('public.fu21_cost_reads'); RETURN true; END $f$;
DO $instrument$ DECLARE d text:=pg_get_viewdef('public.v_job_cost_events'::regclass,true); cols text; BEGIN
 SELECT string_agg(quote_ident(column_name),',' ORDER BY ordinal_position) INTO cols FROM information_schema.columns WHERE table_schema='public' AND table_name='v_job_cost_events';
 EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS WITH observed AS MATERIALIZED (SELECT c.*,public.fu21_observe_cost() AS seen FROM ('||rtrim(d,E';\n ')||') c) SELECT '||cols||' FROM observed WHERE seen';
END $instrument$;
CREATE SEQUENCE public.fu21_revenue_reads;
CREATE FUNCTION public.fu21_observe_revenue() RETURNS boolean LANGUAGE plpgsql AS $f$
/* function block */ BEGIN PERFORM nextval('public.fu21_revenue_reads'); RETURN true; END $f$;
DO $instrument$ DECLARE d text:=pg_get_viewdef('public.v_job_revenue_events'::regclass,true); cols text; BEGIN
 SELECT string_agg(quote_ident(column_name),',' ORDER BY ordinal_position) INTO cols FROM information_schema.columns WHERE table_schema='public' AND table_name='v_job_revenue_events';
 EXECUTE 'CREATE OR REPLACE VIEW public.v_job_revenue_events AS WITH observed AS MATERIALIZED (SELECT r.*,public.fu21_observe_revenue() AS seen FROM ('||rtrim(d,E';\n ')||') r) SELECT '||cols||' FROM observed WHERE seen';
END $instrument$;
CREATE TEMP TABLE fu21_revenue_count AS SELECT count(*) n FROM public.v_job_revenue_events;
CREATE TEMP TABLE fu21_cost_count AS SELECT count(*) n FROM public.v_job_cost_events;
ALTER SEQUENCE public.fu21_revenue_reads RESTART;
ALTER SEQUENCE public.fu21_cost_reads RESTART;
SELECT public.job_profit_refresh_many(ARRAY(SELECT job_id FROM fu21_expected));
DO $once$ BEGIN
 IF (SELECT last_value FROM public.fu21_cost_reads)<>(SELECT n FROM fu21_cost_count) THEN
  RAISE EXCEPTION 'FU21 cost stream built more than once'; END IF;
 IF (SELECT last_value FROM public.fu21_revenue_reads)<>(SELECT n FROM fu21_revenue_count) THEN
  RAISE EXCEPTION 'FU21 revenue stream built more than once (reads %, rows %)',(SELECT last_value FROM public.fu21_revenue_reads),(SELECT n FROM fu21_revenue_count); END IF;
END $once$;
-- Office edits are read on retry, never replaced with yesterday's stored amount.
UPDATE public.xero_invoices SET sub_total=120,total=132,
 line_items='[{"LineItemID":"fu21-cost-2","Description":"Panels","LineAmount":120,"TaxAmount":12,"AccountCode":"310"}]'
 WHERE xero_invoice_id='fu21-bill-2';
SELECT public.job_profit_refresh('f0210000-0000-4000-8000-000000000002');
DO $edit$ BEGIN
 IF (SELECT actual_cost_ex FROM public.job_profit_stored WHERE job_number='ZZTEST-FU21-2') IS DISTINCT FROM 120::numeric THEN
  RAISE EXCEPTION 'FU21 office edit not refreshed'; END IF;
END $edit$;
-- Unreadable input rolls the whole replacement back and keeps its dirty mark.
SELECT public.job_profit_mark('f0210000-0000-4000-8000-000000000002','cost');
CREATE TEMP TABLE fu21_before_failure AS SELECT * FROM public.job_profit_stored;
CREATE OR REPLACE FUNCTION public.fu21_observe_cost() RETURNS boolean LANGUAGE plpgsql AS $f$
/* function block */ BEGIN RAISE EXCEPTION 'FU21 injected read failure'; END $f$;
DO $failure$ BEGIN
 BEGIN
  PERFORM public.job_profit_refresh('f0210000-0000-4000-8000-000000000002');
  RAISE EXCEPTION 'FU21 missing read failure';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FU21 injected read failure' THEN RAISE; END IF; END;
 IF EXISTS((SELECT * FROM public.job_profit_stored EXCEPT SELECT * FROM fu21_before_failure)
  UNION ALL (SELECT * FROM fu21_before_failure EXCEPT SELECT * FROM public.job_profit_stored))
  OR NOT EXISTS(SELECT 1 FROM public.job_profit_dirty WHERE job_id='f0210000-0000-4000-8000-000000000002') THEN
  RAISE EXCEPTION 'FU21 failed read changed stored rows or consumed mark'; END IF;
END $failure$;
CREATE OR REPLACE FUNCTION public.fu21_observe_cost() RETURNS boolean LANGUAGE plpgsql AS $f$
/* function block */ BEGIN PERFORM nextval('public.fu21_cost_reads'); RETURN true; END $f$;
SELECT public.job_profit_refresh('f0210000-0000-4000-8000-000000000002');
DO $retry$ BEGIN
 IF EXISTS(SELECT 1 FROM public.job_profit_dirty WHERE job_id='f0210000-0000-4000-8000-000000000002') THEN
  RAISE EXCEPTION 'FU21 retry did not consume mark'; END IF;
 BEGIN PERFORM public.job_profit_refresh_all(); RAISE EXCEPTION 'FU21 unbounded call survived';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'job_profit_refresh_all_requires_batch_cursor' THEN RAISE; END IF; END;
 IF has_function_privilege('authenticated','public.job_profit_refresh_all(uuid,integer)','execute') THEN
  RAISE EXCEPTION 'FU21 browser refill access'; END IF;
END $retry$;
-- One page only in a transaction, even when a caller mistakenly loops in SQL.
DO $page$ DECLARE r jsonb; BEGIN
 r:=public.job_profit_refresh_all('f020ffff-ffff-ffff-ffff-ffffffffffff',2);
 IF r->>'next_after'<>'f0210000-0000-4000-8000-000000000002' OR r->>'done'<>'false' OR r->>'refreshed'<>'2' THEN
  RAISE EXCEPTION 'FU21 page did not stop at its bound: %',r; END IF;
 BEGIN PERFORM public.job_profit_refresh_all((r->>'next_after')::uuid,2); RAISE EXCEPTION 'FU21 multi-page transaction survived';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'job_profit_refresh_all_commit_before_next_batch' THEN RAISE; END IF; END;
END $page$;
SELECT 'PASS: FU21 real credit, unverified and no-cost equality; one cost and revenue build; office edit; failed read and retry; bounded page' AS result;
ROLLBACK;
