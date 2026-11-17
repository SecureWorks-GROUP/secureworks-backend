BEGIN;
SET LOCAL statement_timeout='120s';
-- Rule 17: restore creating migration before asserting its objects. Every
-- fixture, replaced helper and trigger below is restored by this ROLLBACK.
\ir ../../../migrations/20261118000101_job_profit_source_refresh.sql
CREATE TEMP TABLE fu32_before AS
 SELECT oid,proname,prosrc,pg_get_functiondef(oid) definition,proacl,proconfig,prosecdef
 FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND (proname ~ '^job_profit_.*_trg$' OR proname='job_profit_source_changed');
\ir ../../../migrations/20261118000102_job_profit_trigger_switch_first.sql
DO $check$ DECLARE before_row record; after_row record; gate text:=$gate$
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;$gate$; BEGIN
 IF (SELECT count(*) FROM fu32_before WHERE proname<>'job_profit_source_changed')<>11 THEN RAISE EXCEPTION 'FU32 expected eleven wrappers'; END IF;
 FOR before_row IN SELECT * FROM fu32_before LOOP
  SELECT * INTO after_row FROM pg_proc WHERE oid=before_row.oid;
  IF before_row.proname='job_profit_source_changed' THEN
   IF after_row.prosrc IS DISTINCT FROM before_row.prosrc THEN RAISE EXCEPTION 'FU32 helper behavior changed'; END IF;
  ELSE
   -- Exact enabled-path parity, and the gate is the first executable statement.
   IF after_row.prosrc IS DISTINCT FROM replace(before_row.prosrc,' BEGIN',' BEGIN'||gate)
    OR after_row.prosrc ~* '\mEXCEPTION[[:space:]]+WHEN\M' THEN
    RAISE EXCEPTION 'FU32 gate not first or enabled path changed: %',before_row.proname;
   END IF;
  END IF;
  IF after_row.proacl IS DISTINCT FROM before_row.proacl OR after_row.proconfig IS DISTINCT FROM before_row.proconfig
   OR after_row.prosecdef IS DISTINCT FROM before_row.prosecdef THEN RAISE EXCEPTION 'FU32 function authority changed'; END IF;
 END LOOP;
END $check$;
-- Idempotent application keeps the gate once, never nesting it on a retry.
\ir ../../../migrations/20261118000102_job_profit_trigger_switch_first.sql
-- Restore these small fixture relations only inside the rolled-back contract.
DROP TABLE IF EXISTS public.jobs CASCADE;
CREATE TABLE public.jobs(id uuid PRIMARY KEY,org_id uuid,job_number text,client_name text,type text,status text,metadata jsonb,expected_costs jsonb,pricing_json jsonb,completed_at timestamptz,created_at timestamptz,legacy boolean);
DROP TABLE IF EXISTS public.job_materials_facts CASCADE;
CREATE TABLE public.job_materials_facts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,xero_invoice_id text);
DROP TABLE IF EXISTS public.trade_invoice_lines CASCADE;
CREATE TABLE public.trade_invoice_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,trade_invoice_id uuid);
DROP TABLE IF EXISTS public.group_work_orders CASCADE;
CREATE TABLE public.group_work_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
DROP TABLE IF EXISTS public.group_work_order_shares CASCADE;
CREATE TABLE public.group_work_order_shares(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),group_id uuid);
DROP TABLE IF EXISTS public.xero_invoices CASCADE;
CREATE TABLE public.xero_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,xero_invoice_id text,reference text,invoice_number text,line_items jsonb,synced_at timestamptz,updated_at timestamptz);
DROP TABLE IF EXISTS public.xero_supplier_credit_note_allocations CASCADE;
CREATE TABLE public.xero_supplier_credit_note_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xero_invoice_id text);
DROP TABLE IF EXISTS public.trade_invoices CASCADE;
CREATE TABLE public.trade_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
DROP TABLE IF EXISTS public.purchase_orders CASCADE;
CREATE TABLE public.purchase_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
DROP TABLE IF EXISTS public.job_budgets CASCADE;
CREATE TABLE public.job_budgets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
DROP TABLE IF EXISTS public.work_orders CASCADE;
CREATE TABLE public.work_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
-- Reuse the same indexed columns as the source migrations, no new live index.
CREATE INDEX ON public.jobs(upper(job_number));
CREATE INDEX ON public.trade_invoice_lines(trade_invoice_id);
CREATE INDEX ON public.xero_invoices(xero_invoice_id);
CREATE INDEX ON public.job_materials_facts(xero_invoice_id);
CREATE TEMP TABLE fu32_page_marks(job_id uuid,reason text);
DROP FUNCTION IF EXISTS public.job_mark_changed(uuid,text) CASCADE;
-- Test-only stand-in for main's page notifier, to observe calls and read faults.
CREATE FUNCTION public.job_mark_changed(uuid,text) RETURNS void LANGUAGE plpgsql AS $mark$ BEGIN
 IF current_setting('fu32.fail',true)='on' THEN RAISE EXCEPTION 'FU32 fixture read failed'; END IF;
 INSERT INTO pg_temp.fu32_page_marks VALUES($1,$2);
END $mark$;
-- A cast which to_jsonb(record) really invokes. Disabled writes must never
-- reach it; the deliberate serialization control below proves that it trips.
CREATE TYPE public.fu32_payload_probe AS ENUM('fixture');
CREATE FUNCTION public.fu32_payload_probe_json(public.fu32_payload_probe) RETURNS json LANGUAGE plpgsql AS $json$ BEGIN
 RAISE EXCEPTION 'FU32 serialization entered';
END $json$;
CREATE CAST (public.fu32_payload_probe AS json) WITH FUNCTION public.fu32_payload_probe_json(public.fu32_payload_probe);
CREATE TEMP TABLE fu32_probe(id uuid,job_id uuid,payload jsonb,serialization_probe public.fu32_payload_probe DEFAULT 'fixture');
INSERT INTO pg_temp.fu32_probe(id) VALUES('00000000-0000-0000-0000-000000000001');
DO $control$ BEGIN
 BEGIN
  PERFORM to_jsonb(p) FROM pg_temp.fu32_probe p;
  RAISE EXCEPTION 'FU32 serialization control did not trip';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FU32 serialization entered' THEN RAISE; END IF; END;
END $control$;
TRUNCATE pg_temp.fu32_probe;
CREATE TEMP TABLE fu32_helper_calls(source text);
-- Probe replaces the real helper only for the disabled-path observations.
-- Calling it would enter the original helper's EXCEPTION subtransaction even
-- when the helper itself immediately returns off. Zero calls proves bypass.
CREATE OR REPLACE FUNCTION public.job_profit_source_changed(p_table text,p_old jsonb,p_new jsonb,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='25ms' AS $probe$ BEGIN
 INSERT INTO pg_temp.fu32_helper_calls VALUES(p_table);
END $probe$;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_profit_refresh_v1';
DO $off$ DECLARE f text; mode integer; BEGIN
 FOR mode IN 1..2 LOOP
  IF mode=2 THEN DELETE FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1'; END IF;
  FOR f IN SELECT proname FROM fu32_before WHERE proname<>'job_profit_source_changed' LOOP
   EXECUTE format('CREATE TRIGGER fu32_off AFTER INSERT OR UPDATE OR DELETE ON pg_temp.fu32_probe FOR EACH ROW EXECUTE FUNCTION public.%I()',f);
   -- A deliberately wide source row, matching the Xero serialization hazard.
   INSERT INTO pg_temp.fu32_probe(id,job_id,payload) VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',jsonb_build_object('blob',repeat('x',1000000)));
   UPDATE pg_temp.fu32_probe SET payload=payload||'{"changed":true}';
   DELETE FROM pg_temp.fu32_probe;
   DROP TRIGGER fu32_off ON pg_temp.fu32_probe;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.fu32_helper_calls) OR EXISTS(SELECT 1 FROM public.job_profit_change_events)
 THEN RAISE EXCEPTION 'FU32 disabled trigger entered helper/queued work'; END IF;
END $off$;
-- Restore the real helper and use the real installer definitions for every
-- enabled-path behavior test. No cron or real install function is invoked.
DO $restore$ BEGIN
 EXECUTE (SELECT definition FROM fu32_before WHERE proname='job_profit_source_changed');
END $restore$;
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('job_profit_refresh_v1',true);
DO $install$ DECLARE m text[]; BEGIN
 FOR m IN SELECT regexp_matches(prosrc,'(CREATE TRIGGER[^;]+;)','g') FROM pg_proc
  WHERE oid='public.job_profit_refresh_install()'::regprocedure LOOP EXECUTE m[1]; END LOOP;
END $install$;
-- Capture exact event multisets under each implementation. Sequences and
-- timestamps are not compared; source job and reason are the queue contract.
CREATE TEMP TABLE fu32_events(variant integer,step text,job_id uuid,reason text);
CREATE TEMP TABLE fu32_pages(variant integer,step text,job_id uuid,reason text);
CREATE FUNCTION pg_temp.fu32_capture(v integer,s text) RETURNS void LANGUAGE plpgsql AS $capture$ BEGIN
 INSERT INTO pg_temp.fu32_events SELECT v,s,job_id,reason FROM public.job_profit_change_events;
 INSERT INTO pg_temp.fu32_pages SELECT v,s,job_id,reason FROM pg_temp.fu32_page_marks;
 TRUNCATE public.job_profit_change_events,pg_temp.fu32_page_marks;
END $capture$;
DO $on$ DECLARE v_variant integer; f record; a uuid:='00000000-0000-0000-0000-000000000001'; b uuid:='00000000-0000-0000-0000-000000000002'; BEGIN
 FOR v_variant IN 1..2 LOOP
  -- Variant 1 is this migration; variant 2 is the exact parent wrappers.
  IF v_variant=2 THEN
   FOR f IN SELECT definition FROM fu32_before WHERE proname<>'job_profit_source_changed' LOOP EXECUTE f.definition; END LOOP;
  END IF;
  TRUNCATE public.jobs,public.job_materials_facts,public.trade_invoice_lines,public.trade_invoices,public.purchase_orders,public.job_budgets,public.xero_invoices,public.xero_supplier_credit_note_allocations,public.work_orders,public.group_work_order_shares,public.group_work_orders;
  INSERT INTO public.jobs(id,job_number) VALUES(a,'SWF-900001'),(b,'SWF-900002');
  PERFORM pg_temp.fu32_capture(v_variant,'jobs_insert');
  INSERT INTO public.xero_invoices(id,job_id,xero_invoice_id,reference) VALUES(a,a,'fixture-invoice','SWF-900001');
  PERFORM pg_temp.fu32_capture(v_variant,'invoice_insert');
  UPDATE public.xero_invoices SET synced_at=clock_timestamp(),updated_at=clock_timestamp();
  PERFORM pg_temp.fu32_capture(v_variant,'timestamp_only');
  UPDATE public.xero_invoices SET job_id=b,line_items='[{"Description":"SWF-900002"}]';
  PERFORM pg_temp.fu32_capture(v_variant,'office_relink');
  INSERT INTO public.trade_invoice_lines(id,job_id,trade_invoice_id) VALUES(a,a,b);
  INSERT INTO public.trade_invoices(id) VALUES(b);
  DELETE FROM public.trade_invoices;
  PERFORM pg_temp.fu32_capture(v_variant,'crew_header_lookup');
  UPDATE public.trade_invoice_lines SET job_id=b;
  PERFORM pg_temp.fu32_capture(v_variant,'crew_relink');
  INSERT INTO public.job_materials_facts(job_id,xero_invoice_id) VALUES(a,'fixture-invoice');
  INSERT INTO public.xero_supplier_credit_note_allocations(xero_invoice_id) VALUES('fixture-invoice');
  PERFORM pg_temp.fu32_capture(v_variant,'credit_lookup');
  INSERT INTO public.group_work_orders(id,job_id) VALUES(a,a);
  INSERT INTO public.group_work_order_shares(group_id) VALUES(a);
  PERFORM pg_temp.fu32_capture(v_variant,'group_lookup');
  INSERT INTO public.group_work_order_shares(group_id) VALUES(b);
  INSERT INTO public.xero_supplier_credit_note_allocations(xero_invoice_id) VALUES('not-found');
  PERFORM pg_temp.fu32_capture(v_variant,'missing_related_data');
  INSERT INTO public.work_orders(job_id) VALUES(a);
  INSERT INTO public.job_budgets(job_id) VALUES(a);
  PERFORM pg_temp.fu32_capture(v_variant,'direct_sources');
  UPDATE public.jobs SET status='accepted' WHERE id=a;
  PERFORM pg_temp.fu32_capture(v_variant,'job_office_edit');
  UPDATE public.jobs SET status=status;
  PERFORM pg_temp.fu32_capture(v_variant,'job_unchanged');
  PERFORM set_config('fu32.fail','on',true);
  INSERT INTO public.purchase_orders(id,job_id) VALUES(a,a);
  IF NOT EXISTS(SELECT 1 FROM public.purchase_orders WHERE id=a) THEN RAISE EXCEPTION 'FU32 failed read blocked business write'; END IF;
  PERFORM pg_temp.fu32_capture(v_variant,'failed_read');
  PERFORM set_config('fu32.fail','off',true);
  UPDATE public.purchase_orders SET job_id=b WHERE id=a;
  PERFORM pg_temp.fu32_capture(v_variant,'retry_office_edit');
  DELETE FROM public.xero_invoices;
  PERFORM pg_temp.fu32_capture(v_variant,'invoice_delete');
 END LOOP;
 IF EXISTS(
  (SELECT step,job_id,reason FROM pg_temp.fu32_events WHERE variant=1 EXCEPT ALL SELECT step,job_id,reason FROM pg_temp.fu32_events WHERE variant=2)
  UNION ALL
  (SELECT step,job_id,reason FROM pg_temp.fu32_events WHERE variant=2 EXCEPT ALL SELECT step,job_id,reason FROM pg_temp.fu32_events WHERE variant=1)
 ) OR EXISTS(
  (SELECT step,job_id,reason FROM pg_temp.fu32_pages WHERE variant=1 EXCEPT ALL SELECT step,job_id,reason FROM pg_temp.fu32_pages WHERE variant=2)
  UNION ALL
  (SELECT step,job_id,reason FROM pg_temp.fu32_pages WHERE variant=2 EXCEPT ALL SELECT step,job_id,reason FROM pg_temp.fu32_pages WHERE variant=1)
 ) THEN RAISE EXCEPTION 'FU32 enabled behavior differs from parent'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp.fu32_events WHERE step IN('timestamp_only','missing_related_data','job_unchanged','failed_read'))
 OR (SELECT count(DISTINCT job_id) FROM pg_temp.fu32_events WHERE variant=1 AND step='office_relink')<>2
 OR (SELECT count(DISTINCT job_id) FROM pg_temp.fu32_events WHERE variant=1 AND step='retry_office_edit')<>2
 THEN RAISE EXCEPTION 'FU32 bad-path or relink expectations'; END IF;
END $on$;
-- Natural plans with 10,000 unrelated rows, no enable_seqscan override and no
-- index-name pin. Assert each relation is index-scanned, without a Seq Scan.
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_profit_refresh_v1';
INSERT INTO public.jobs(id,job_number) SELECT md5('fu32-job-'||n)::uuid,'ZZTEST-'||n FROM generate_series(1,10000) n;
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id) SELECT md5('fu32-line-'||n)::uuid,md5('fu32-invoice-'||n)::uuid FROM generate_series(1,10000) n;
INSERT INTO public.xero_invoices(id,xero_invoice_id) SELECT md5('fu32-xero-'||n)::uuid,n::text FROM generate_series(1,10000) n;
INSERT INTO public.job_materials_facts(id,xero_invoice_id) SELECT md5('fu32-fact-'||n)::uuid,n::text FROM generate_series(1,10000) n;
INSERT INTO public.group_work_orders(id) SELECT md5('fu32-group-'||n)::uuid FROM generate_series(1,10000) n;
INSERT INTO public.feature_flags(flag_name,enabled) SELECT 'fu32-fixture-'||n,false FROM generate_series(1,10000) n ON CONFLICT DO NOTHING;
ANALYZE public.jobs; ANALYZE public.trade_invoice_lines; ANALYZE public.xero_invoices;
ANALYZE public.job_materials_facts; ANALYZE public.group_work_orders; ANALYZE public.feature_flags;
DO $plans$ DECLARE q text; plan jsonb; scan record; scanned text[]; BEGIN
 FOREACH q IN ARRAY ARRAY[
  'SELECT 1 FROM public.feature_flags WHERE flag_name=''job_profit_refresh_v1'' AND enabled',
  'SELECT array_agg(j.id) FROM public.jobs j WHERE upper(j.job_number)=ANY(ARRAY[''SWF-900001'',''SWF-900002''])',
  'SELECT array_agg(DISTINCT l.job_id) FROM public.trade_invoice_lines l WHERE l.trade_invoice_id=''00000000-0000-0000-0000-000000000002''',
  'SELECT ARRAY[g.job_id] FROM public.group_work_orders g WHERE g.id=''00000000-0000-0000-0000-000000000001''',
  'SELECT array_agg(job_id) FROM (SELECT x.job_id FROM public.xero_invoices x WHERE x.xero_invoice_id=''fixture-invoice'' UNION SELECT f.job_id FROM public.job_materials_facts f WHERE f.xero_invoice_id=''fixture-invoice'') linked'
 ] LOOP
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '||q INTO plan;
  scanned:='{}';
  FOR scan IN WITH RECURSIVE nodes(n) AS (
   SELECT plan->0->'Plan' UNION ALL SELECT child FROM nodes CROSS JOIN LATERAL jsonb_array_elements(coalesce(n->'Plans','[]')) child
  ) SELECT n FROM nodes WHERE n ? 'Relation Name' LOOP
   IF scan.n->>'Node Type' NOT IN('Index Scan','Index Only Scan','Bitmap Heap Scan')
    OR (scan.n->>'Actual Rows')::integer>2 OR coalesce((scan.n->>'Rows Removed by Filter')::integer,0)>2 THEN
    RAISE EXCEPTION 'FU32 unbounded lookup: %',plan;
   END IF;
   scanned:=array_append(scanned,scan.n->>'Relation Name');
  END LOOP;
  IF cardinality(scanned)=0 OR plan::text LIKE '%Seq Scan%' THEN RAISE EXCEPTION 'FU32 missing native indexed scan: %',plan; END IF;
  IF q LIKE '%UNION%' AND NOT scanned @> ARRAY['xero_invoices','job_materials_facts'] THEN RAISE EXCEPTION 'FU32 credit lookup missed a relation'; END IF;
 END LOOP;
END $plans$;
SELECT 'PASS: FU32 eleven first-statement gates, 66 disabled writes, zero helper entries, fifteen enabled parity scenarios and six indexed relations' AS result;
ROLLBACK;
