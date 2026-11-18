\set ON_ERROR_STOP on
BEGIN;
SET LOCAL jit = off;
SET LOCAL statement_timeout = '120s';
\ir ../../../migrations/20261118170100_job_profit_read_views.sql
\ir ../20261118024514_context_story_book_speed/fixtures.sql
CREATE FUNCTION pg_temp.check_read(ok boolean, assertion text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'profit_read_contract: %', assertion; END IF; END $fn$;

-- Compare bags of complete rows, including duplicate events and SQL NULLs.
CREATE FUNCTION pg_temp.check_sources(j uuid, stored boolean) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE stem text; expected text; diff boolean;
BEGIN
 FOREACH stem IN ARRAY ARRAY['job_profit','job_cost_events','job_revenue_events'] LOOP
  -- A stored row is compared on the read view's columns: a column only the
  -- store has is not published.
  expected := CASE WHEN stored THEN format('SELECT to_jsonb(x)-%L::text[] FROM public.%I x WHERE job_id=$1',
     (SELECT coalesce(array_agg(s.attname::text),'{}') FROM pg_attribute s WHERE s.attrelid=('public.'||stem||'_stored')::regclass
       AND s.attnum>0 AND NOT s.attisdropped AND s.attname<>'computed_at' AND NOT EXISTS (SELECT 1 FROM pg_attribute l
        WHERE l.attrelid=('public.v_'||stem)::regclass AND l.attname=s.attname AND l.attnum>0 AND NOT l.attisdropped)),stem||'_stored')
    ELSE format('SELECT to_jsonb(x)||jsonb_build_object(''computed_at'',NULL) FROM public.%I x WHERE job_id=$1','v_'||stem) END;
  EXECUTE format('WITH want AS (%s), got AS (SELECT to_jsonb(x) FROM public.%I x WHERE job_id=$1)
    SELECT EXISTS ((TABLE want EXCEPT ALL TABLE got) UNION ALL (TABLE got EXCEPT ALL TABLE want))',
    expected,'v_'||stem||'_read') INTO diff USING j;
  PERFORM pg_temp.check_read(NOT diff,stem||CASE WHEN stored THEN '_stored' ELSE '_live' END);
 END LOOP;
END $fn$;
SELECT id AS job FROM public.jobs WHERE job_number='MB-1' \gset
SELECT id AS other_job FROM public.jobs WHERE job_number='MB-2' \gset
SELECT pg_temp.check_read(NOT public.job_profit_read_on(),'switch_off');
-- Each read view has exactly the live view's columns plus computed_at, and
-- the store carries every one of them.
SELECT pg_temp.check_read(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['job_profit','job_cost_events','job_revenue_events']) stem
 CROSS JOIN LATERAL (
  (SELECT attname::text FROM pg_attribute WHERE attrelid=('public.v_'||stem||'_read')::regclass AND attnum>0 AND NOT attisdropped
   EXCEPT SELECT attname::text FROM pg_attribute WHERE attrelid=('public.v_'||stem)::regclass AND attnum>0 AND NOT attisdropped
   EXCEPT SELECT 'computed_at')
  UNION ALL
  (SELECT attname::text FROM pg_attribute WHERE attrelid=('public.v_'||stem)::regclass AND attnum>0 AND NOT attisdropped
   UNION SELECT 'computed_at'
   EXCEPT SELECT attname::text FROM pg_attribute WHERE attrelid=('public.v_'||stem||'_read')::regclass AND attnum>0 AND NOT attisdropped)
 ) d),'read_view_columns_are_live_plus_computed_at');
SELECT pg_temp.check_sources(:'job',false);
-- Compare the public evidence result at one stable as-of instant. The one-job
-- money rule and every line in its evidence are part of this equality.
CREATE TEMP TABLE evidence_before AS SELECT result FROM public.job_profit_line_evidence_many(ARRAY[:'job'::uuid]);
SELECT pg_temp.check_read(public.job_profit_line_evidence(:'job')=(SELECT result FROM evidence_before),'evidence_off');
DELETE FROM public.feature_flags WHERE flag_name='job_profit_stored_read_v1';
SELECT pg_temp.check_sources(:'job',false);
INSERT INTO public.feature_flags(flag_name,enabled) VALUES ('job_profit_stored_read_v1',true);
SELECT pg_temp.check_sources(:'job',false); -- No row and no arm.
-- Only the refresh source triggers are needed for this fixture. Use their
-- installer definitions; the cron extension is outside this contract.
DO $triggers$ DECLARE m text[]; BEGIN
 FOR m IN SELECT regexp_matches(prosrc,'(CREATE TRIGGER job_profit_changed[^;]+ ON (public\.[a-z_]+)[^;]+;)','g')
  FROM pg_proc WHERE oid='public.job_profit_refresh_install()'::regprocedure LOOP
  EXECUTE 'DROP TRIGGER IF EXISTS job_profit_changed ON '||m[2]; EXECUTE m[1];
 END LOOP;
END $triggers$;
INSERT INTO public.feature_flags(flag_name,enabled) VALUES ('job_profit_refresh_v1',true)
 ON CONFLICT(flag_name) DO UPDATE SET enabled=true;
SELECT public.install_context_story_book_speed();
SELECT public.install_job_story_stored_profit();
UPDATE public.job_story_stored_profit_arm SET armed_at=now()-interval '1 day' WHERE singleton;
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh(:'job');
-- now() is constant across this rolled-back test. The refresh normally commits
-- before the read starts. Represent that order and let the real trigger
-- fingerprint these exact event rows.
UPDATE public.job_cost_events_stored SET computed_at=now() WHERE job_id=:'job';
UPDATE public.job_revenue_events_stored SET computed_at=now() WHERE job_id=:'job';
UPDATE public.job_profit_stored SET computed_at=now() WHERE job_id=:'job';
SELECT pg_temp.check_read(public.job_profit_read_as_at(:'job')=now(),'fresh_after_refresh');
SELECT pg_temp.check_sources(:'job',true);
SELECT pg_temp.check_sources(:'other_job',false);
SELECT pg_temp.check_read(EXISTS (SELECT 1 FROM public.job_cost_events_stored WHERE job_id=:'job')
 AND EXISTS (SELECT 1 FROM public.job_revenue_events_stored WHERE job_id=:'job'),'nonempty_event_sets');
SELECT pg_temp.check_read(public.job_profit_line_evidence(:'job')=(SELECT result FROM evidence_before),'evidence_stored');
-- Compare a real on-demand build on both routes. Build times differ by
-- construction, so compare the whole card, money and status without as_at.
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_profit_stored_read_v1';
DELETE FROM public.job_pages WHERE job_id=:'job';
CREATE TEMP TABLE page_before AS SELECT public.job_page_get(:'job') - 'as_at' AS payload;
SELECT pg_temp.check_read((SELECT payload->>'status'='ready' AND jsonb_typeof(payload#>'{story_text,money}')='object' FROM page_before),'page_baseline');
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_profit_stored_read_v1';
DELETE FROM public.job_pages WHERE job_id=:'job';
SELECT pg_temp.check_read(public.job_page_get(:'job')-'as_at'=(SELECT payload FROM page_before),'page_cold_stored');
SELECT pg_temp.check_read(public.job_page_get(:'job')-'as_at'=(SELECT payload FROM page_before),'page_cache_hit');
-- With the ordinary book unavailable, a cold get still builds the very same
-- page when fresh. Reading the baseline book here would fail the page build.
SAVEPOINT live_book_unavailable;
ALTER FUNCTION public.context_job_story_book(uuid,timestamptz) RENAME TO profit_read_live_book_unavailable;
DELETE FROM public.job_pages WHERE job_id=:'job';
SELECT pg_temp.check_read(public.job_page_get(:'job')-'as_at'=(SELECT payload FROM page_before),'page_skips_live_book');
ROLLBACK TO live_book_unavailable;
-- The evidence path must still work when the live profit views are unavailable.
SAVEPOINT live_unavailable;
ALTER VIEW public.v_job_profit RENAME TO profit_read_live_unavailable;
SELECT pg_temp.check_read(public.job_profit_line_evidence(:'job')=(SELECT result FROM evidence_before),'evidence_skips_live');
ROLLBACK TO live_unavailable;
SAVEPOINT office_edit;
UPDATE public.xero_invoices SET amount_paid=amount_paid+1 WHERE xero_invoice_id='MB-INV-1';
SELECT public.job_mark_changed(:'job','payment');
SELECT pg_temp.check_sources(:'job',false);
SELECT pg_temp.check_read(public.job_profit_line_evidence(:'job')=(SELECT result FROM public.job_profit_line_evidence_many(ARRAY[:'job'::uuid])),'evidence_after_edit');
SELECT pg_temp.check_read(public.job_profit_page_card_for_text(:'job','{}')='{}','page_after_edit');
ROLLBACK TO office_edit;
SAVEPOINT unreadable;
ALTER TABLE public.job_change_mark_events RENAME TO unreadable_change_mark_fixture;
SELECT pg_temp.check_sources(:'job',false);
ROLLBACK TO unreadable;
SELECT pg_temp.check_sources(:'job',true);
-- The API reads as the service role. A switch it cannot read is off: live
-- rows. With the switch readable it takes the stored route end to end. The
-- grant stands in for the one the live service role already holds.
REVOKE SELECT ON public.feature_flags FROM service_role;
SET LOCAL ROLE service_role;
SELECT count(*) AS sr_rows, count(computed_at) AS sr_stored FROM public.v_job_profit_read WHERE job_id=:'job' \gset
SELECT count(*) AS sr_cost FROM public.v_job_cost_events_read WHERE job_id=:'job' \gset
SELECT count(*) AS sr_revenue FROM public.v_job_revenue_events_read WHERE job_id=:'job' \gset
RESET ROLE;
SELECT pg_temp.check_read(:sr_rows=1 AND :sr_stored=0 AND :sr_cost>0 AND :sr_revenue>0,'service_role_unreadable_switch_reads_live');
GRANT SELECT ON public.feature_flags TO service_role;
SET LOCAL ROLE service_role;
SELECT count(*) AS sr_rows, count(computed_at) AS sr_stored FROM public.v_job_profit_read WHERE job_id=:'job' \gset
SELECT count(*) AS sr_cost, count(computed_at) AS sr_cost_stored FROM public.v_job_cost_events_read WHERE job_id=:'job' \gset
SELECT count(*) AS sr_revenue, count(computed_at) AS sr_revenue_stored FROM public.v_job_revenue_events_read WHERE job_id=:'job' \gset
SELECT public.job_profit_line_evidence(:'job') IS NOT NULL AS sr_evidence \gset
RESET ROLE;
SELECT pg_temp.check_read(:sr_rows=1 AND :sr_stored=1 AND :sr_cost>0 AND :sr_cost_stored=:sr_cost
 AND :sr_revenue>0 AND :sr_revenue_stored=:sr_revenue AND :'sr_evidence'::boolean,'service_role_stored_route');
DO $acl$ DECLARE r regclass; BEGIN
 FOREACH r IN ARRAY ARRAY['public.v_job_profit_read'::regclass,'public.v_job_cost_events_read'::regclass,
   'public.v_job_revenue_events_read'::regclass] LOOP
  PERFORM pg_temp.check_read(has_table_privilege('service_role',r,'SELECT') AND
   NOT has_table_privilege('anon',r,'SELECT') AND NOT has_table_privilege('authenticated',r,'SELECT'),'view_access');
 END LOOP;
END $acl$;
-- Give the planner a meaningful choice. These unrelated rows never enter a
-- stored read for the one fixture job; the assertions inspect executed nodes.
SET LOCAL session_replication_role=replica;
INSERT INTO public.jobs(id,org_id,type,status,job_number)
 SELECT md5('p0095-'||n)::uuid,'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-P0095-'||n
 FROM generate_series(1,2000) n;
INSERT INTO public.job_profit_stored(job_id) SELECT md5('p0095-'||n)::uuid FROM generate_series(1,2000) n;
INSERT INTO public.job_cost_events_stored(job_id) SELECT md5('p0095-'||n)::uuid FROM generate_series(1,2000) n;
INSERT INTO public.job_revenue_events_stored(job_id) SELECT md5('p0095-'||n)::uuid FROM generate_series(1,2000) n;
SET LOCAL session_replication_role=origin;
ANALYZE public.jobs;
ANALYZE public.job_profit_stored;
ANALYZE public.job_cost_events_stored;
ANALYZE public.job_revenue_events_stored;
DO $plans$ DECLARE stem text; plan jsonb; j uuid; rel text;
BEGIN
 SELECT id INTO STRICT j FROM public.jobs WHERE job_number='MB-1';
 FOREACH stem IN ARRAY ARRAY['job_profit','job_cost_events','job_revenue_events'] LOOP
  EXECUTE format('EXPLAIN (ANALYZE,FORMAT JSON,TIMING OFF) SELECT * FROM public.%I WHERE job_id=%L',
   'v_'||stem||'_read',j) INTO plan;
  FOR rel IN SELECT unnest(ARRAY['jobs',stem||'_stored']) LOOP
   PERFORM pg_temp.check_read(EXISTS (SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (exists(@."Relation Name"))') n
    WHERE n->>'Relation Name'=rel AND (n->>'Actual Loops')::int>0
     AND n->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan')
     AND (n->>'Actual Rows')::int+coalesce((n->>'Rows Removed by Filter')::int,0)<16),stem||'_index_'||rel);
  END LOOP;
  PERFORM pg_temp.check_read(NOT EXISTS (SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (exists(@."Relation Name"))') n
   WHERE (n->>'Actual Loops')::int>0 AND n->>'Relation Name' NOT IN ('jobs',stem||'_stored')),stem||'_ran_live_branch');
 END LOOP;
END $plans$;
-- Mixed company page, including thousands of jobs with stale rows. A
-- set-based fallback may scan its live input for the list once. It must
-- never execute that scan separately for every missing or stale job.
DO $list$ DECLARE plan jsonb;
BEGIN
 EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON,TIMING OFF) SELECT job_id,computed_at,profit_ex FROM public.v_job_profit_read ORDER BY created_at DESC,job_id LIMIT 51' INTO plan;
 PERFORM pg_temp.check_read(NOT EXISTS (SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (exists(@."Relation Name"))') n
   WHERE n->>'Node Type'='Seq Scan' AND n->>'Relation Name' IN ('jobs','xero_invoices','trade_invoices')
    AND (n->>'Actual Loops')::int>=100),'list_repeated_company_scan');
END $list$;
-- A legacy job is absent from the live profit population. It stays absent
-- on both routes, even while events for it can still exist.
UPDATE public.jobs SET legacy=true WHERE id=:'other_job';
SELECT pg_temp.check_read(NOT EXISTS(SELECT 1 FROM public.v_job_profit_read WHERE job_id=:'other_job'),'legacy_outside_profit');
-- Switch off is what merges. Each query the API sends must execute exactly the
-- relation scans, the same number of times, as the same query on main's view.
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_profit_stored_read_v1';
CREATE FUNCTION pg_temp.executed_scans(q text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE plan jsonb;
BEGIN
 EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON,TIMING OFF) '||q INTO plan;
 RETURN (SELECT coalesce(jsonb_agg(x ORDER BY x),'[]') FROM (SELECT (n->>'Node Type')||':'||(n->>'Relation Name')||':'||(n->>'Actual Loops') x
   FROM jsonb_path_query(plan,'strict $.** ? (exists(@."Relation Name"))') n
   WHERE (n->>'Actual Loops')::int>0 AND n->>'Relation Name'<>'feature_flags') s);
END $fn$;
DO $off$ DECLARE q text[]; main_scans jsonb;
BEGIN
 FOREACH q SLICE 1 IN ARRAY ARRAY[
  ['one_job','v_job_profit%s WHERE job_id=(SELECT id FROM public.jobs WHERE job_number=''MB-1'') LIMIT 2'],
  ['list','v_job_profit%s ORDER BY created_at DESC, job_id ASC LIMIT 51'],
  ['list_type','v_job_profit%s WHERE work_type IN (''fencing'') ORDER BY created_at DESC, job_id ASC LIMIT 51'],
  ['list_status_dates','v_job_profit%s WHERE status IN (''accepted'') AND created_at>=now()-interval ''30 days'' ORDER BY created_at DESC, job_id ASC LIMIT 51 OFFSET 50'],
  ['rollup_page','v_job_profit%s ORDER BY created_at DESC, job_id ASC LIMIT 1000 OFFSET 1000'],
  ['cost_events','v_job_cost_events%s WHERE job_id=(SELECT id FROM public.jobs WHERE job_number=''MB-1'') ORDER BY event_date ASC LIMIT 2000'],
  ['revenue_events','v_job_revenue_events%s WHERE job_id=(SELECT id FROM public.jobs WHERE job_number=''MB-1'') ORDER BY invoice_date ASC LIMIT 2000']
 ] LOOP
  main_scans := pg_temp.executed_scans('SELECT * FROM public.'||format(q[2],''));
  PERFORM pg_temp.check_read(jsonb_array_length(main_scans)>0
   AND pg_temp.executed_scans('SELECT * FROM public.'||format(q[2],'_read'))=main_scans,'switch_off_same_scans_'||q[1]);
 END LOOP;
END $off$;
\ir ../../../rollbacks/20261118170100_job_profit_read_views_down.sql
SELECT pg_temp.check_read(to_regclass('public.v_job_profit_read') IS NULL
 AND (SELECT md5(prosrc)='e07cf775a74cda10cca2e40d4bafc540' FROM pg_proc WHERE oid='public.job_profit_line_evidence(uuid)'::regprocedure)
 AND EXISTS(SELECT 1 FROM public.job_profit_stored WHERE job_id=:'job'),'rollback');
-- The rollback leaves both replaced functions exactly as main has them, and
-- nothing of this migration's. Then the migration applies again, and again
-- over itself.
SELECT pg_temp.check_read((SELECT md5(prosrc)='4fad727218d2eda48113c658512f86b9' FROM pg_proc WHERE oid='public.job_page_get(uuid)'::regprocedure)
 AND (SELECT l.lanname='sql' FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid='public.job_profit_line_evidence(uuid)'::regprocedure)
 AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('job_profit_read_on','job_profit_read_as_at',
  'job_profit_read_rows','job_cost_events_read_rows','job_revenue_events_read_rows','job_profit_read_stored_evidence','job_profit_page_refresh','job_profit_page_card_for_text'))
 AND has_function_privilege('service_role','public.job_page_get(uuid)','EXECUTE')
 AND has_function_privilege('service_role','public.job_profit_line_evidence(uuid)','EXECUTE'),'rollback_restores_main');
\ir ../../../migrations/20261118170100_job_profit_read_views.sql
\ir ../../../migrations/20261118170100_job_profit_read_views.sql
SELECT pg_temp.check_read(to_regclass('public.v_job_profit_read') IS NOT NULL
 AND has_function_privilege('service_role','public.job_page_get(uuid)','EXECUTE')
 AND has_function_privilege('service_role','public.job_profit_line_evidence(uuid)','EXECUTE')
 AND NOT has_function_privilege('service_role','public.job_profit_page_refresh(uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.job_profit_read_rows()','EXECUTE'),'applies_again');
SELECT pg_temp.check_sources(:'job',false);
ROLLBACK;
\echo P0-09.5 read views PASS: 3 sources, 3 indexed plans, switch off/missing, 7 switch-off plans equal main, fresh, missing, office change, unreadable and retry, service role, private access, rollback and re-apply
