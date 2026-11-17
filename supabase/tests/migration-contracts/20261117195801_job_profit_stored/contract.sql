BEGIN;
SET LOCAL TimeZone='UTC';
DO $schema$ DECLARE rel text; v text; BEGIN
 FOREACH rel IN ARRAY ARRAY['job_profit_stored','job_cost_events_stored','job_revenue_events_stored','job_profit_dirty'] LOOP
  IF to_regclass('public.'||rel) IS NULL THEN RAISE EXCEPTION 'stored profit table missing: %',rel; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||rel) AND relrowsecurity) THEN
   RAISE EXCEPTION 'stored profit RLS missing';
  END IF;
  IF has_table_privilege('authenticated','public.'||rel,'SELECT') OR has_table_privilege('anon','public.'||rel,'SELECT') THEN
   RAISE EXCEPTION 'stored profit browser access';
  END IF;
 END LOOP;
 FOREACH v IN ARRAY ARRAY['profit','cost_events','revenue_events'] LOOP
  rel:=CASE v WHEN 'profit' THEN 'job_profit_stored' ELSE 'job_'||v||'_stored' END;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=rel AND column_name='computed_at' AND data_type='timestamp with time zone' AND is_nullable='NO') THEN
   RAISE EXCEPTION 'stored profit computed_at missing';
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns a LEFT JOIN information_schema.columns b
    ON b.table_schema='public' AND b.table_name=rel AND b.column_name=a.column_name
    WHERE a.table_schema='public' AND a.table_name='v_job_'||v AND
      (b.column_name IS NULL OR a.udt_name IS DISTINCT FROM b.udt_name OR (b.is_nullable<>'YES' AND NOT (v='profit' AND a.column_name='job_id')) OR b.column_default IS NOT NULL)) THEN
   RAISE EXCEPTION 'stored profit copied columns changed';
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_stored_read_v1' AND NOT enabled) THEN
  RAISE EXCEPTION 'stored profit switch must start off';
 END IF;
END $schema$;
-- Baseline is empty and stays uncalled on merge.
DO $empty$ BEGIN
 IF EXISTS(SELECT 1 FROM public.job_profit_stored) OR EXISTS(SELECT 1 FROM public.job_cost_events_stored)
  OR EXISTS(SELECT 1 FROM public.job_revenue_events_stored) OR EXISTS(SELECT 1 FROM public.job_profit_dirty) THEN
  RAISE EXCEPTION 'stores must be empty before first explicit refresh';
 END IF;
 IF has_function_privilege('authenticated','public.job_profit_refresh(uuid)','execute')
  OR has_table_privilege('authenticated','public.job_profit_stored','select') THEN
  RAISE EXCEPTION 'profit store must be service-role only';
 END IF;
END $empty$;
-- Replace only inside this rolled-back contract: no production fixture or live call.
CREATE TABLE public.job_profit_contract_profit_fixture(job_id uuid PRIMARY KEY, job_number text, profit_ex numeric);
CREATE TABLE public.job_profit_contract_cost_fixture(job_id uuid, amount_ex numeric);
CREATE TABLE public.job_profit_contract_revenue_fixture(job_id uuid, amount_ex numeric);
-- Stand-in views and tables are transactional fixtures, not deployed replacements.
DROP VIEW public.v_job_profit CASCADE;
DROP VIEW public.v_job_cost_events CASCADE;
DROP VIEW public.v_job_revenue_events CASCADE;
CREATE VIEW public.v_job_profit AS SELECT * FROM public.job_profit_contract_profit_fixture;
CREATE VIEW public.v_job_cost_events AS SELECT * FROM public.job_profit_contract_cost_fixture;
CREATE VIEW public.v_job_revenue_events AS SELECT * FROM public.job_profit_contract_revenue_fixture;
DROP TABLE public.job_profit_stored;
CREATE TABLE public.job_profit_stored(LIKE public.v_job_profit,computed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(job_id));
DROP TABLE public.job_cost_events_stored;
CREATE TABLE public.job_cost_events_stored(LIKE public.v_job_cost_events,computed_at timestamptz NOT NULL DEFAULT now());
DROP TABLE public.job_revenue_events_stored;
CREATE TABLE public.job_revenue_events_stored(LIKE public.v_job_revenue_events,computed_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.job_profit_contract_profit_fixture VALUES('00000000-0000-0000-0000-000000000001','ZZTEST-A',NULL),('00000000-0000-0000-0000-000000000002','ZZTEST-B',20);
INSERT INTO public.job_profit_contract_cost_fixture VALUES('00000000-0000-0000-0000-000000000001',10),('00000000-0000-0000-0000-000000000001',NULL);
INSERT INTO public.job_profit_contract_revenue_fixture VALUES('00000000-0000-0000-0000-000000000001',30);
DROP FUNCTION IF EXISTS public.job_mark_changed(uuid,text) CASCADE;
SELECT public.job_profit_refresh('00000000-0000-0000-0000-000000000001');
DO $check$ BEGIN
 IF (SELECT count(*) FROM public.job_profit_stored)<>1 OR EXISTS(SELECT 1 FROM public.job_profit_stored WHERE profit_ex IS NOT NULL) THEN
  RAISE EXCEPTION 'refresh must isolate A and preserve unknown';
 END IF;
 IF public.job_profit_refresh_many('{}'::uuid[])<>'{"refreshed":0,"changed":0,"ms":0}'::jsonb THEN RAISE EXCEPTION 'empty batch'; END IF;
 BEGIN
  PERFORM public.job_profit_refresh_many(ARRAY(SELECT gen_random_uuid() FROM generate_series(1,501)));
  RAISE EXCEPTION 'missing batch cap';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'job_profit_refresh_too_many' THEN RAISE; END IF;
 END;
END $check$;
SELECT public.job_profit_refresh('00000000-0000-0000-0000-000000000002');
CREATE TEMP TABLE before_refresh AS SELECT * FROM public.job_profit_stored;
CREATE TEMP TABLE page_marks(job_id uuid,source text);
CREATE FUNCTION public.job_mark_changed(uuid,text) RETURNS void LANGUAGE sql AS 'INSERT INTO pg_temp.page_marks VALUES($1,$2)';
UPDATE public.job_profit_contract_profit_fixture SET profit_ex=15 WHERE job_number='ZZTEST-A';
SELECT public.job_profit_refresh('00000000-0000-0000-0000-000000000001');
DO $check$ BEGIN
 IF (SELECT count(*) FROM page_marks WHERE source='profit')<>1 THEN RAISE EXCEPTION 'changed figure must mark once'; END IF;
 IF EXISTS(SELECT 1 FROM public.job_profit_stored n JOIN before_refresh o USING(job_id) WHERE n.job_number='ZZTEST-B' AND n IS DISTINCT FROM o) THEN RAISE EXCEPTION 'refresh changed B'; END IF;
 IF EXISTS(SELECT 1 FROM public.job_profit_stored n JOIN before_refresh o USING(job_id) WHERE n.job_number='ZZTEST-A' AND n.computed_at<=o.computed_at) THEN RAISE EXCEPTION 'refresh did not advance computed_at'; END IF;
END $check$;
SELECT public.job_profit_refresh('00000000-0000-0000-0000-000000000001');
DO $check$ DECLARE result jsonb; BEGIN
 IF (SELECT count(*) FROM page_marks)<>1 THEN RAISE EXCEPTION 'unchanged refresh must not mark'; END IF;
 result:=public.job_profit_stored_compare();
 IF result->'differences'<>'[]' OR result->'missing_in_stored'<>'[]' OR result->'missing_columns'<>'[]' THEN RAISE EXCEPTION 'equal stored rows must compare equal: %',result; END IF;
 UPDATE public.job_profit_stored SET profit_ex=1 WHERE job_number='ZZTEST-A';
 result:=public.job_profit_stored_compare();
 IF jsonb_array_length(result->'differences')<>1 OR result#>>'{differences,0,column}'<>'profit_ex' THEN RAISE EXCEPTION 'changed amount must be reported: %',result; END IF;
 UPDATE public.job_cost_events_stored SET amount_ex=11 WHERE amount_ex=10;
 result:=public.job_profit_stored_compare();
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'differences') d WHERE d->>'column'='cost_events') THEN RAISE EXCEPTION 'event total mismatch not reported'; END IF;
END $check$;
SELECT public.job_profit_mark('00000000-0000-0000-0000-000000000001','cost');
SELECT public.job_profit_mark('00000000-0000-0000-0000-000000000001','invoice');
DO $check$ BEGIN
 IF (SELECT count(*) FROM public.job_profit_dirty)<>1 THEN RAISE EXCEPTION 'mark must upsert'; END IF;
END $check$;
SELECT public.job_profit_refresh_marked();
DO $check$ BEGIN
 IF EXISTS(SELECT 1 FROM public.job_profit_dirty) OR public.job_profit_refresh_marked()<>'{"refreshed":0,"left":0}'::jsonb THEN RAISE EXCEPTION 'marked refresh must consume marks'; END IF;
END $check$;
SELECT 'PASS: stored profit schema, scoped refresh, NULL, timestamp, compare, cap, marks and page notification' AS result;
ROLLBACK;
