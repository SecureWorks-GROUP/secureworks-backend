BEGIN;
SET LOCAL statement_timeout='120s';
-- Rule 17: restore our prerequisites before asserting objects, then restore this
-- whole test database at ROLLBACK. No earlier contract is edited.
\ir ../../../migrations/20261117195801_job_profit_stored.sql
CREATE TEMP TABLE compare_legacy_body AS SELECT prosrc FROM pg_proc WHERE oid='public.job_profit_stored_compare(integer)'::regprocedure;
\ir ../../../migrations/20261118000101_job_profit_source_refresh.sql
DO $check$ DECLARE t text; BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='job_profit_changed') THEN RAISE EXCEPTION 'merge installed trigger'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RAISE EXCEPTION 'merge enabled worker'; END IF;
 IF public.job_profit_refresh_due()<>'{"state":"off"}' OR public.job_profit_daily_mark()<>'{"state":"off"}' THEN RAISE EXCEPTION 'off worker ran'; END IF;
 FOREACH t IN ARRAY ARRAY['job_profit_change_events','job_profit_daily_cursor'] LOOP
  IF has_table_privilege('anon','public.'||t,'SELECT') OR has_table_privilege('authenticated','public.'||t,'INSERT') THEN RAISE EXCEPTION 'browser queue access'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.'||t)) THEN RAISE EXCEPTION 'queue RLS missing'; END IF;
 END LOOP;
 IF has_function_privilege('authenticated','public.job_profit_refresh_install()','EXECUTE') OR has_function_privilege('anon','public.job_profit_refresh_due()','EXECUTE') THEN RAISE EXCEPTION 'browser worker access'; END IF;
END $check$;
-- Small real SQL fixtures for source-routing behavior, not a replacement engine.
-- Everything, including CASCADE effects on the old stack, rolls back at the end.
DROP TABLE public.jobs CASCADE;
CREATE TABLE public.jobs(id uuid PRIMARY KEY,org_id uuid,job_number text,client_name text,type text,status text,metadata jsonb,expected_costs jsonb,pricing_json jsonb,completed_at timestamptz,created_at timestamptz,legacy boolean);
DROP TABLE IF EXISTS public.job_materials_facts CASCADE;
CREATE TABLE public.job_materials_facts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,xero_invoice_id text,amount_ex numeric);
DROP TABLE IF EXISTS public.trade_invoice_lines CASCADE;
CREATE TABLE public.trade_invoice_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,trade_invoice_id uuid);
DROP TABLE IF EXISTS public.trade_invoices CASCADE;
CREATE TABLE public.trade_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
DROP TABLE IF EXISTS public.purchase_orders CASCADE;
CREATE TABLE public.purchase_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
DROP TABLE IF EXISTS public.job_budgets CASCADE;
CREATE TABLE public.job_budgets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
DROP TABLE IF EXISTS public.xero_invoices CASCADE;
CREATE TABLE public.xero_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,xero_invoice_id text,reference text,invoice_number text,line_items jsonb,synced_at timestamptz,updated_at timestamptz);
DROP TABLE IF EXISTS public.xero_supplier_credit_note_allocations CASCADE;
CREATE TABLE public.xero_supplier_credit_note_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xero_invoice_id text);
DROP TABLE IF EXISTS public.work_orders CASCADE;
CREATE TABLE public.work_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
DROP TABLE IF EXISTS public.group_work_order_shares CASCADE;
CREATE TABLE public.group_work_order_shares(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),group_id uuid);
DROP TABLE IF EXISTS public.group_work_orders CASCADE;
CREATE TABLE public.group_work_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
CREATE INDEX ON public.jobs(upper(job_number));
CREATE INDEX ON public.trade_invoice_lines(trade_invoice_id);
CREATE INDEX ON public.xero_invoices(xero_invoice_id);
CREATE INDEX ON public.job_materials_facts(xero_invoice_id);
DROP FUNCTION IF EXISTS public.job_mark_changed(uuid,text) CASCADE;
CREATE TEMP TABLE page_marks(job_id uuid,source text);
CREATE FUNCTION public.job_mark_changed(uuid,text) RETURNS void LANGUAGE sql AS 'INSERT INTO pg_temp.page_marks VALUES($1,$2)';
DROP VIEW IF EXISTS public.v_job_profit CASCADE;
DROP VIEW IF EXISTS public.v_job_cost_events CASCADE;
DROP VIEW IF EXISTS public.v_job_revenue_events CASCADE;
CREATE VIEW public.v_job_cost_events AS SELECT job_id,amount_ex FROM public.job_materials_facts;
CREATE VIEW public.v_job_revenue_events AS SELECT id job_id,NULL::numeric amount_ex FROM public.jobs WHERE false;
CREATE VIEW public.v_job_profit AS SELECT j.id job_id,j.job_number,sum(f.amount_ex) profit_ex FROM public.jobs j LEFT JOIN public.job_materials_facts f ON f.job_id=j.id GROUP BY j.id;
DROP TABLE public.job_profit_stored;
DROP TABLE public.job_cost_events_stored;
DROP TABLE public.job_revenue_events_stored;
CREATE TABLE public.job_profit_stored(LIKE public.v_job_profit,computed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(job_id));
CREATE TABLE public.job_cost_events_stored(LIKE public.v_job_cost_events,computed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.job_revenue_events_stored(LIKE public.v_job_revenue_events,computed_at timestamptz NOT NULL DEFAULT now());
-- Installer must refuse missing bounded-refill prerequisite before any install.
DROP FUNCTION IF EXISTS public.job_profit_refresh_all(uuid,integer);
DO $check$ BEGIN
 BEGIN
  PERFORM public.job_profit_refresh_install(); RAISE EXCEPTION 'accepted unbounded writer';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'job_profit_bounded_refill_required' THEN RAISE; END IF;
 END;
END $check$;
-- Only availability is read by the installer. Refreshes use the real existing
-- job_profit_refresh_marked -> refresh_many. Nothing invokes this test stub.
CREATE FUNCTION public.job_profit_refresh_all(uuid,integer) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
-- Disposable cron stand-in, since native pg_cron may be unavailable on a Mac.
-- If pg_cron is registered its real schedule is rolled back with the contract.
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
  BEGIN
   PERFORM public.job_profit_refresh_install(); RAISE EXCEPTION 'missing cron accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'job_profit_pg_cron_required' THEN RAISE; END IF; END;
 ELSE
  PERFORM public.job_profit_refresh_install();
  IF (SELECT count(*) FROM cron.job WHERE jobname IN('job-profit-refresh-marked','job-profit-refresh-daily'))<>2 THEN RAISE EXCEPTION 'timer install'; END IF;
  PERFORM public.job_profit_refresh_remove();
 END IF;
END $check$;
DO $triggers$ DECLARE m text[]; source text; BEGIN
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.job_profit_refresh_install()'::regprocedure;
 FOR m IN SELECT regexp_matches(source,'(CREATE TRIGGER[^;]+;)','g') LOOP EXECUTE m[1]; END LOOP;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname='job_profit_changed')<>11 THEN RAISE EXCEPTION 'source trigger count'; END IF;
END $triggers$;
INSERT INTO public.jobs(id,job_number) VALUES('00000000-0000-0000-0000-000000000001','SWF-900001'),('00000000-0000-0000-0000-000000000002','SWF-900002');
INSERT INTO public.job_materials_facts(job_id,xero_invoice_id) VALUES('00000000-0000-0000-0000-000000000001','fixture-bill');
DO $check$ BEGIN IF EXISTS(SELECT 1 FROM public.job_profit_change_events) THEN RAISE EXCEPTION 'off source changed queue'; END IF; END $check$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_profit_refresh_v1';
INSERT INTO public.job_materials_facts(job_id,amount_ex) VALUES('00000000-0000-0000-0000-000000000001',NULL);
DO $check$ BEGIN
 IF (SELECT count(*) FROM public.job_profit_change_events)<>1 OR EXISTS(SELECT 1 FROM public.job_profit_change_events WHERE job_id<>'00000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'fact must queue only A'; END IF;
 IF EXISTS(SELECT 1 FROM public.job_profit_dirty) THEN RAISE EXCEPTION 'business source touched dirty row'; END IF;
END $check$;
SELECT public.job_profit_refresh_due();
DO $check$ BEGIN
 IF (SELECT count(*) FROM public.job_profit_stored)<>1 OR EXISTS(SELECT 1 FROM public.job_profit_stored WHERE profit_ex IS NOT NULL) THEN RAISE EXCEPTION 'refresh isolate/null'; END IF;
 IF EXISTS(SELECT 1 FROM public.job_profit_change_events) OR EXISTS(SELECT 1 FROM public.job_profit_dirty) THEN RAISE EXCEPTION 'fold not trimmed'; END IF;
END $check$;
INSERT INTO public.xero_invoices(id,job_id,reference) VALUES('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','SWF-900001');
TRUNCATE public.job_profit_change_events;
UPDATE public.xero_invoices SET synced_at=clock_timestamp(),updated_at=clock_timestamp();
DO $check$ BEGIN IF EXISTS(SELECT 1 FROM public.job_profit_change_events) THEN RAISE EXCEPTION 'timestamp-only xero mark'; END IF; END $check$;
UPDATE public.xero_invoices SET line_items='[{"Description":"SWF-900002"}]';
DO $check$ BEGIN IF (SELECT count(DISTINCT job_id) FROM public.job_profit_change_events)<>2 THEN RAISE EXCEPTION 'line token missing B'; END IF; END $check$;
TRUNCATE public.job_profit_change_events;
INSERT INTO public.trade_invoice_lines(id,job_id) VALUES('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001');
TRUNCATE public.job_profit_change_events;
UPDATE public.trade_invoice_lines SET job_id='00000000-0000-0000-0000-000000000002';
DO $check$ BEGIN IF (SELECT count(DISTINCT job_id) FROM public.job_profit_change_events)<>2 THEN RAISE EXCEPTION 'moved crew line lost old/new'; END IF; END $check$;
TRUNCATE public.job_profit_change_events;
INSERT INTO public.xero_supplier_credit_note_allocations(xero_invoice_id) VALUES('fixture-bill');
DO $check$ BEGIN IF (SELECT count(*) FROM public.job_profit_change_events)<>1 THEN RAISE EXCEPTION 'credit bill fact job lookup'; END IF; END $check$;
TRUNCATE public.job_profit_change_events;
INSERT INTO public.group_work_orders(id,job_id) VALUES('30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001');
TRUNCATE public.job_profit_change_events;
INSERT INTO public.group_work_order_shares(group_id) VALUES('30000000-0000-0000-0000-000000000001');
DO $check$ BEGIN IF (SELECT count(*) FROM public.job_profit_change_events)<>1 THEN RAISE EXCEPTION 'group parent lookup'; END IF; END $check$;
-- Every direct source uses the same old/new boundary. Actual job changes avoid
-- serializing the unrelated full jobs blob, and identical saves produce no mark.
TRUNCATE public.job_profit_change_events;
UPDATE public.jobs SET status='accepted' WHERE id='00000000-0000-0000-0000-000000000001';
DO $check$ BEGIN IF (SELECT count(*) FROM public.job_profit_change_events)<>1 THEN RAISE EXCEPTION 'job column change not queued'; END IF; END $check$;
TRUNCATE public.job_profit_change_events;
UPDATE public.jobs SET status=status;
DO $check$ BEGIN IF EXISTS(SELECT 1 FROM public.job_profit_change_events) THEN RAISE EXCEPTION 'same job save queued'; END IF; END $check$;
INSERT INTO public.trade_invoices(id) VALUES('40000000-0000-0000-0000-000000000001');
UPDATE public.trade_invoice_lines SET trade_invoice_id='40000000-0000-0000-0000-000000000001';
TRUNCATE public.job_profit_change_events;
DELETE FROM public.trade_invoices;
DO $check$ BEGIN IF (SELECT count(*) FROM public.job_profit_change_events)<>1 THEN RAISE EXCEPTION 'crew header delete lost line job'; END IF; END $check$;
TRUNCATE public.job_profit_change_events;
INSERT INTO public.work_orders(job_id) VALUES('00000000-0000-0000-0000-000000000001');
INSERT INTO public.job_budgets(job_id) VALUES('00000000-0000-0000-0000-000000000001');
DO $check$ BEGIN IF (SELECT count(*) FROM public.job_profit_change_events)<>2 THEN RAISE EXCEPTION 'work order/budget missing'; END IF; END $check$;
-- Failed page notification must not fail a business write. Daily net recovers it.
CREATE OR REPLACE FUNCTION public.job_mark_changed(uuid,text) RETURNS void LANGUAGE plpgsql AS $fail$ BEGIN RAISE EXCEPTION 'fixture read failure'; END $fail$;
TRUNCATE public.job_profit_change_events;
INSERT INTO public.purchase_orders(job_id) VALUES('00000000-0000-0000-0000-000000000002');
DO $check$ BEGIN
 IF (SELECT count(*) FROM public.purchase_orders)<>1 OR EXISTS(SELECT 1 FROM public.job_profit_change_events) THEN RAISE EXCEPTION 'source failure not isolated'; END IF;
END $check$;
CREATE OR REPLACE FUNCTION public.job_mark_changed(uuid,text) RETURNS void LANGUAGE sql AS 'INSERT INTO pg_temp.page_marks VALUES($1,$2)';
SELECT public.job_profit_daily_mark();
DO $check$ BEGIN IF (SELECT count(*) FROM public.job_profit_dirty)<>2 THEN RAISE EXCEPTION 'daily recovery'; END IF; END $check$;
SELECT public.job_profit_refresh_due();
DO $check$ BEGIN IF (public.job_profit_daily_mark()->>'marked')::int<>0 THEN RAISE EXCEPTION 'daily repeated'; END IF; END $check$;
-- Office edit then source failure leaves old stored values/queued work for retry.
CREATE FUNCTION public.job_profit_fixture_read_failure() RETURNS numeric LANGUAGE plpgsql AS $fail$ BEGIN RAISE EXCEPTION 'fixture source unreadable'; END $fail$;
UPDATE public.job_materials_facts SET amount_ex=7 WHERE xero_invoice_id='fixture-bill';
CREATE TEMP TABLE before_failure AS SELECT * FROM public.job_profit_stored;
CREATE OR REPLACE VIEW public.v_job_cost_events AS SELECT job_id,public.job_profit_fixture_read_failure() amount_ex FROM public.job_materials_facts;
DO $check$ BEGIN
 BEGIN PERFORM public.job_profit_refresh_due(); RAISE EXCEPTION 'unreadable source accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'fixture source unreadable' THEN RAISE; END IF; END;
 IF NOT EXISTS(SELECT 1 FROM public.job_profit_change_events) OR EXISTS((SELECT * FROM public.job_profit_stored EXCEPT SELECT * FROM before_failure) UNION ALL (SELECT * FROM before_failure EXCEPT SELECT * FROM public.job_profit_stored)) THEN RAISE EXCEPTION 'failed read lost old store or mark'; END IF;
END $check$;
CREATE OR REPLACE VIEW public.v_job_cost_events AS SELECT job_id,amount_ex FROM public.job_materials_facts;
SELECT public.job_profit_refresh_due();
DO $check$ BEGIN IF (SELECT profit_ex FROM public.job_profit_stored WHERE job_id='00000000-0000-0000-0000-000000000001')<>7 OR EXISTS(SELECT 1 FROM public.job_profit_change_events) THEN RAISE EXCEPTION 'retry missed office edit'; END IF; END $check$;
-- Daily pagination: at most 500 keys, next call continues, never a full timer sum.
ALTER TABLE public.jobs DISABLE TRIGGER job_profit_changed;
INSERT INTO public.jobs(id,job_number) SELECT md5('fixture-job-'||n)::uuid,'ZZTEST-'||n FROM generate_series(1,10000) n;
ALTER TABLE public.jobs ENABLE TRIGGER job_profit_changed;
TRUNCATE public.job_profit_dirty;
UPDATE public.job_profit_daily_cursor SET sweep_day=sweep_day-1;
DO $check$ DECLARE a uuid; result jsonb; BEGIN
 IF (public.job_profit_daily_mark()->>'marked')::int<>500 THEN RAISE EXCEPTION 'daily cap'; END IF;
 SELECT after_job_id INTO a FROM public.job_profit_daily_cursor;
 result:=public.job_profit_daily_mark();
 IF (result->>'marked')::int<>500 OR (SELECT after_job_id FROM public.job_profit_daily_cursor)<=a THEN RAISE EXCEPTION 'daily continuation'; END IF;
END $check$;
-- A daily backlog must not delay a new source. Only B's old store is removed;
-- a source queue event must put B into this refresh even with 1,000 older marks.
DELETE FROM public.job_profit_stored WHERE job_id='00000000-0000-0000-0000-000000000002';
INSERT INTO public.job_profit_change_events(job_id,reason) VALUES('00000000-0000-0000-0000-000000000002','fresh_fixture');
SELECT public.job_profit_refresh_due();
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.job_profit_stored WHERE job_id='00000000-0000-0000-0000-000000000002') THEN RAISE EXCEPTION 'daily backlog delayed source'; END IF;
END $check$;
-- Native plans: inspect scans on each added large-table read, not index names.
ANALYZE public.jobs; ANALYZE public.xero_invoices; ANALYZE public.trade_invoice_lines; ANALYZE public.job_materials_facts; ANALYZE public.group_work_orders;
DO $plans$ DECLARE q text; plan jsonb; BEGIN
 -- Populate fixture lookups so the native planner has representative selectivity.
 INSERT INTO public.trade_invoice_lines(id,trade_invoice_id) SELECT md5('fixture-line-'||n)::uuid,md5('fixture-invoice-'||n)::uuid FROM generate_series(1,10000) n;
 INSERT INTO public.xero_invoices(id,xero_invoice_id) SELECT md5('fixture-xero-'||n)::uuid,n::text FROM generate_series(1,10000) n;
 INSERT INTO public.job_materials_facts(id,xero_invoice_id) SELECT md5('fixture-fact-'||n)::uuid,n::text FROM generate_series(1,10000) n;
 INSERT INTO public.group_work_orders(id) SELECT md5('fixture-group-'||n)::uuid FROM generate_series(1,10000) n;
 INSERT INTO public.job_profit_change_events(job_id,reason) SELECT '00000000-0000-0000-0000-000000000001','plan_fixture' FROM generate_series(1,10000);
 ANALYZE public.job_profit_change_events; ANALYZE public.job_profit_dirty;
 ANALYZE public.trade_invoice_lines; ANALYZE public.xero_invoices; ANALYZE public.job_materials_facts; ANALYZE public.group_work_orders;
 FOREACH q IN ARRAY ARRAY[
  'SELECT id FROM public.job_profit_change_events ORDER BY id LIMIT 200',
  'SELECT job_id FROM public.job_profit_dirty ORDER BY marked_at,job_id LIMIT 200',
  'SELECT id FROM public.jobs ORDER BY id LIMIT 500',
  'SELECT id FROM public.jobs WHERE id>''80000000-0000-0000-0000-000000000000'' ORDER BY id LIMIT 500',
  'SELECT id FROM public.jobs WHERE upper(job_number)=ANY(ARRAY[''SWF-900001''])',
  'SELECT job_id FROM public.trade_invoice_lines WHERE trade_invoice_id=''00000000-0000-0000-0000-000000000001''',
  'SELECT job_id FROM public.xero_invoices WHERE xero_invoice_id=''fixture-bill''',
  'SELECT job_id FROM public.job_materials_facts WHERE xero_invoice_id=''fixture-bill''',
  'SELECT job_id FROM public.group_work_orders WHERE id=''30000000-0000-0000-0000-000000000001'''
 ] LOOP
  EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) '||q INTO plan;
  IF plan::text LIKE '%Seq Scan%' OR plan::text NOT LIKE '%Index%Scan%' THEN RAISE EXCEPTION 'unbounded lookup %: %',q,plan; END IF;
 END LOOP;
END $plans$;
-- Remove only this lane's install; queues survive for re-install and rollback.
SELECT public.job_profit_refresh_remove();
DO $check$ BEGIN IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='job_profit_changed') THEN RAISE EXCEPTION 'remove left trigger'; END IF; END $check$;
SELECT 'PASS: P0-09.4 scope A source isolation, timestamp noise, old/new jobs, credit/group lookup, failure recovery, daily cursor and nine native plans' AS result;
-- The new diagnostic takes explicit ids and never changes the legacy body.
DO $check$ BEGIN
 IF (SELECT prosrc FROM compare_legacy_body) IS DISTINCT FROM
  (SELECT prosrc FROM pg_proc WHERE oid='public.job_profit_stored_compare(integer)'::regprocedure) THEN RAISE EXCEPTION 'legacy compare changed'; END IF;
 IF has_function_privilege('anon','public.job_profit_stored_compare(uuid[])','EXECUTE')
 OR has_function_privilege('authenticated','public.job_profit_stored_compare(uuid[])','EXECUTE')
 OR NOT has_function_privilege('service_role','public.job_profit_stored_compare(uuid[])','EXECUTE') THEN RAISE EXCEPTION 'id compare access'; END IF;
END $check$;
-- Fixtures have unrelated jobs, including drift which MUST stay out of scope.
TRUNCATE public.job_profit_stored,public.job_cost_events_stored,public.job_revenue_events_stored,public.job_materials_facts;
CREATE INDEX ON public.job_materials_facts(job_id);
CREATE INDEX ON public.job_cost_events_stored(job_id);
CREATE INDEX ON public.job_revenue_events_stored(job_id);
INSERT INTO public.job_materials_facts(job_id,amount_ex) VALUES
 ('00000000-0000-0000-0000-000000000001',1.25),
 ('00000000-0000-0000-0000-000000000002',NULL);
INSERT INTO public.job_profit_stored SELECT p.*,now() FROM public.v_job_profit p WHERE job_id IN('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
INSERT INTO public.job_cost_events_stored SELECT p.*,now() FROM public.v_job_cost_events p;
DO $check$ DECLARE ids uuid[]:=ARRAY['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002']::uuid[]; r jsonb; BEGIN
 r:=public.job_profit_stored_compare(ids);
 IF r IS DISTINCT FROM public.job_profit_stored_compare(2) OR r->'jobs'<>'2' OR r->'differences'<>'[]' THEN RAISE EXCEPTION 'id/legacy parity: %',r; END IF;
 IF public.job_profit_stored_compare(ids||ids||ARRAY[NULL]::uuid[]) IS DISTINCT FROM r THEN RAISE EXCEPTION 'duplicate/null ids'; END IF;
 UPDATE public.job_profit_stored SET profit_ex=0 WHERE job_id=ids[2];
 IF NOT public.job_profit_stored_compare(ids)->'differences' @> '[{"column":"profit_ex","stored":0,"view":null}]' THEN RAISE EXCEPTION 'NULL became zero'; END IF;
 UPDATE public.job_profit_stored SET profit_ex=NULL WHERE job_id=ids[2];
 IF public.job_profit_stored_compare(ARRAY[NULL]::uuid[])->'jobs'<>'0' THEN RAISE EXCEPTION 'null element widened scope'; END IF;
 IF public.job_profit_stored_compare(NULL::uuid[])->'jobs'<>'0' OR public.job_profit_stored_compare('{}'::uuid[])->'jobs'<>'0' THEN RAISE EXCEPTION 'empty input widened scope'; END IF;
 BEGIN
  PERFORM public.job_profit_stored_compare(array_fill('00000000-0000-0000-0000-000000000001'::uuid,ARRAY[501]));
  RAISE EXCEPTION 'unbounded ids accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'job_profit_compare_too_many' THEN RAISE; END IF; END;
END $check$;
-- Missing store, NULL vs zero, office edit, stored-only profit and orphan events.
DELETE FROM public.job_profit_stored WHERE job_id='00000000-0000-0000-0000-000000000002';
UPDATE public.jobs SET job_number='SWF-900003' WHERE id='00000000-0000-0000-0000-000000000001';
UPDATE public.job_profit_stored SET profit_ex=0 WHERE job_id='00000000-0000-0000-0000-000000000001';
INSERT INTO public.job_profit_stored(job_id,job_number) VALUES('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','SWF-900004'),('ffffffff-ffff-ffff-ffff-ffffffffffff','SWF-900005');
INSERT INTO public.job_cost_events_stored(job_id,amount_ex) VALUES('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',1.25),('ffffffff-ffff-ffff-ffff-ffffffffffff',1.25);
INSERT INTO public.job_revenue_events_stored(job_id,amount_ex) VALUES('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',NULL),('ffffffff-ffff-ffff-ffff-ffffffffffff',1.25);
DO $check$ DECLARE r jsonb; BEGIN
 r:=public.job_profit_stored_compare(ARRAY['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','dddddddd-dddd-dddd-dddd-dddddddddddd']::uuid[]);
 IF r->'jobs'<>'2' OR r->'missing_in_stored'<>'["00000000-0000-0000-0000-000000000002"]' THEN RAISE EXCEPTION 'missing job accounting: %',r; END IF;
 IF jsonb_array_length(r->'differences')<>5 OR EXISTS(SELECT 1 FROM jsonb_array_elements(r->'differences') d WHERE d->>'job_id'='ffffffff-ffff-ffff-ffff-ffffffffffff') THEN RAISE EXCEPTION 'scoped drift: %',r; END IF;
 IF NOT r->'differences' @> '[{"column":"job_number"},{"column":"profit_ex"},{"column":"job"},{"column":"cost_events"},{"column":"revenue_events"}]' THEN RAISE EXCEPTION 'drift classes: %',r; END IF;
END $check$;
-- Native planner, 10,000 unrelated rows. Existing fixture indexes match the
-- production job_id indexes. Assert bounded reads, not a pinned index name.
INSERT INTO public.job_profit_stored(job_id) SELECT md5('compare-profit-'||n)::uuid FROM generate_series(1,10000) n;
INSERT INTO public.job_cost_events_stored(job_id,amount_ex) SELECT md5('compare-cost-'||n)::uuid,1 FROM generate_series(1,10000) n;
INSERT INTO public.job_revenue_events_stored(job_id,amount_ex) SELECT md5('compare-revenue-'||n)::uuid,1 FROM generate_series(1,10000) n;
INSERT INTO public.job_materials_facts(job_id,amount_ex) SELECT md5('compare-source-'||n)::uuid,1 FROM generate_series(1,10000) n;
ANALYZE public.job_profit_stored; ANALYZE public.job_cost_events_stored; ANALYZE public.job_revenue_events_stored; ANALYZE public.job_materials_facts; ANALYZE public.jobs;
DO $plans$ DECLARE relation text; plan jsonb; BEGIN
 FOREACH relation IN ARRAY ARRAY['job_profit_stored','job_cost_events_stored','job_revenue_events_stored','v_job_profit','v_job_cost_events'] LOOP
  EXECUTE format('EXPLAIN (ANALYZE,FORMAT JSON) SELECT * FROM public.%I WHERE job_id=ANY(ARRAY[''00000000-0000-0000-0000-000000000001'']::uuid[])',relation) INTO plan;
  IF plan::text LIKE '%Seq Scan%' OR plan::text NOT LIKE '%Index%Scan%' THEN RAISE EXCEPTION 'unbounded id read %: %',relation,plan; END IF;
  IF (plan->0->'Plan'->>'Actual Rows')::int>1 THEN RAISE EXCEPTION 'id read escaped scope: %',plan; END IF;
 END LOOP;
END $plans$;
-- Poison the reference projection on every unrequested job. This observes the
-- real overload's materialization scope, not merely a separately written plan.
CREATE FUNCTION pg_temp.compare_probe(job uuid,value numeric) RETURNS numeric LANGUAGE plpgsql AS $probe$ BEGIN
 IF job<>'00000000-0000-0000-0000-000000000001'::uuid THEN RAISE EXCEPTION 'unrequested reference built'; END IF;
 IF current_setting('compare_probe.fail',true)='on' THEN RAISE EXCEPTION 'fixture_read_failed'; END IF;
 RETURN value;
END $probe$;
CREATE OR REPLACE VIEW public.v_job_profit AS SELECT j.id job_id,j.job_number,pg_temp.compare_probe(j.id,sum(f.amount_ex)) profit_ex FROM public.jobs j LEFT JOIN public.job_materials_facts f ON f.job_id=j.id GROUP BY j.id;
DO $check$ DECLARE r jsonb; BEGIN
 PERFORM set_config('compare_probe.fail','on',true);
 BEGIN
  PERFORM public.job_profit_stored_compare(ARRAY['00000000-0000-0000-0000-000000000001']::uuid[]);
  RAISE EXCEPTION 'failed read returned equality';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'fixture_read_failed' THEN RAISE; END IF; END;
 PERFORM set_config('compare_probe.fail','off',true);
 r:=public.job_profit_stored_compare(ARRAY['00000000-0000-0000-0000-000000000001']::uuid[]);
 IF r->'jobs'<>'1' OR jsonb_array_length(r->'differences')<>2 THEN RAISE EXCEPTION 'retry or scoped projection: %',r; END IF;
 IF public.job_profit_stored_compare(ARRAY['00000000-0000-0000-0000-000000000001']::uuid[]) IS DISTINCT FROM r THEN RAISE EXCEPTION 'repeat differs'; END IF;
END $check$;
ALTER TABLE public.job_profit_stored DROP COLUMN profit_ex;
DO $check$ BEGIN
 IF public.job_profit_stored_compare(ARRAY['00000000-0000-0000-0000-000000000001']::uuid[])->'missing_columns'<>'["profit_ex"]' THEN RAISE EXCEPTION 'missing schema hidden'; END IF;
END $check$;
SELECT 'PASS: explicit-id comparison parity, private access, bounded/empty input, five drift classes, five native scoped plans, unrelated-row poison, read fault and retry' AS result;
ROLLBACK;
