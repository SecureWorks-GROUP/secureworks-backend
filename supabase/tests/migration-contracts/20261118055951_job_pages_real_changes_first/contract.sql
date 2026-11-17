BEGIN;
SET LOCAL statement_timeout='120s';
-- Preserve the full main renderer, including the record-close and fair retry
-- branches. Recreate queue storage in case an earlier contract dropped it.
CREATE TEMP TABLE fu33_renderer AS SELECT pg_get_functiondef('public.job_page_refresh(uuid)'::regprocedure) AS body;
\ir ../../../migrations/20261117172503_job_pages_queue_safety.sql
DO $restore$ BEGIN EXECUTE (SELECT body FROM fu33_renderer); END $restore$;
\ir ../../../migrations/20261118055951_job_pages_real_changes_first.sql
DO $renderer$ BEGIN
 IF pg_get_functiondef('public.job_page_refresh(uuid)'::regprocedure)<>(SELECT body FROM fu33_renderer) THEN
  RAISE EXCEPTION 'FU33 replaced the main renderer'; END IF;
END $renderer$;
-- Every fixture, stand-in and rollback is confined to this rolled-back transaction.
INSERT INTO public.organisations(id,name) VALUES('f0330000-0000-4000-8000-000000000001','ZZTEST organisation');
SAVEPOINT plan_population;
INSERT INTO public.jobs(id,org_id,type,status,job_number)
SELECT md5('ZZTEST-FU33-'||g)::uuid,'f0330000-0000-4000-8000-000000000001','fencing','accepted','ZZTEST-FU33-'||g
FROM generate_series(1,12000) g;
INSERT INTO public.job_change_mark_events(job_id,source,marked_at,page_pending)
SELECT md5('ZZTEST-FU33-'||g)::uuid,'profit','2026-01-01',g<=2000 FROM generate_series(1,12000) g;
INSERT INTO public.job_change_marks_base(job_id,sources,first_marked_at,last_marked_at,page_pending)
SELECT md5('ZZTEST-FU33-'||g)::uuid,ARRAY['profit'],'2026-01-01','2026-01-01',g<=2000 FROM generate_series(1,12000) g;
INSERT INTO public.job_change_mark_events(job_id,source,marked_at)
VALUES(md5('ZZTEST-FU33-12000')::uuid,'invoice','2026-02-01');
ANALYZE public.jobs;
ANALYZE public.job_change_mark_events;
ANALYZE public.job_change_marks_base;
DO $priority_plan$ DECLARE p jsonb; q text; rel text; BEGIN
 IF public.job_pages_next_due() IS DISTINCT FROM md5('ZZTEST-FU33-12000')::uuid THEN
  RAISE EXCEPTION 'FU33 invoice starved by 2000 older profit marks'; END IF;
 SELECT prosrc INTO q FROM pg_proc WHERE oid='public.job_pages_next_due()'::regprocedure;
 EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) '||q INTO p;
 FOREACH rel IN ARRAY ARRAY['job_change_mark_events','job_change_marks_base','jobs'] LOOP
  IF jsonb_path_exists(p, '$.** ? (@."Node Type" == "Seq Scan" && @."Relation Name" == $rel)', jsonb_build_object('rel',rel))
   OR NOT jsonb_path_exists(p, '$.** ? ((@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan") && @."Relation Name" == $rel)', jsonb_build_object('rel',rel)) THEN
   RAISE EXCEPTION 'FU33 priority read is not index-bound for %: %',rel,p; END IF;
 END LOOP;
 IF jsonb_path_exists(p,'$.** ? ((@."Relation Name" == "job_change_mark_events" || @."Relation Name" == "job_change_marks_base") && @."Actual Rows" > 1)') THEN
  RAISE EXCEPTION 'FU33 priority probe read more than one candidate per lane: %',p; END IF;
 RAISE NOTICE 'FU33 priority plan: %',p;
END $priority_plan$;
-- A mixed legacy row is real work, and an unknown source never becomes bulk.
UPDATE public.job_change_mark_events SET page_pending=false WHERE source='invoice';
UPDATE public.job_change_marks_base SET page_pending=true,sources=ARRAY['profit','status'],first_marked_at='2026-02-01'
 WHERE job_id=md5('ZZTEST-FU33-11999')::uuid;
DO $mixed$ BEGIN
 IF public.job_pages_next_due() IS DISTINCT FROM md5('ZZTEST-FU33-11999')::uuid THEN RAISE EXCEPTION 'FU33 mixed base row starved'; END IF;
END $mixed$;
UPDATE public.job_change_marks_base SET page_pending=false WHERE job_id=md5('ZZTEST-FU33-11999')::uuid;
INSERT INTO public.job_change_mark_events(job_id,source,marked_at) VALUES(md5('ZZTEST-FU33-11998')::uuid,'future_real_source','2026-02-01');
DO $unknown$ BEGIN
 IF public.job_pages_next_due() IS DISTINCT FROM md5('ZZTEST-FU33-11998')::uuid THEN RAISE EXCEPTION 'FU33 unknown real source starved'; END IF;
END $unknown$;
UPDATE public.job_change_mark_events SET page_pending=true,marked_at='2026-01-02' WHERE source='invoice';
-- Only the renderer is a stand-in here: record each build and acknowledge real
-- queue rows with the real acknowledgement primitive. It is restored by rollback.
CREATE TEMP TABLE fu33_builds(n bigint GENERATED ALWAYS AS IDENTITY,job_id uuid);
CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $stub$
DECLARE v_version bigint; v_at timestamptz; v_events bigint[];
BEGIN
 INSERT INTO fu33_builds(job_id) VALUES(p_job_id);
 IF current_setting('fu33.slow',true)='on' THEN PERFORM pg_sleep(40.1); END IF;
 IF current_setting('fu33.fail',true)='on' THEN
  PERFORM public.job_page_yield(p_job_id); RETURN '{"outcome":"failed"}'; END IF;
 SELECT mark_version,last_marked_at INTO v_version,v_at FROM public.job_change_marks WHERE job_id=p_job_id;
 SELECT array_agg(mark_version) INTO v_events FROM public.job_change_mark_events WHERE job_id=p_job_id;
 IF current_setting('fu33.during',true)='on' THEN PERFORM public.job_mark_changed(p_job_id,'invoice'); END IF;
 PERFORM public.job_page_ack(p_job_id,v_version,v_at,v_events);
 RETURN '{"outcome":"built"}';
END $stub$;
DO $five$ DECLARE result jsonb; p jsonb; q text; BEGIN
 result:=public.job_pages_refresh_due(5);
 IF result->>'refreshed'<>'5' OR (SELECT count(*) FROM fu33_builds)<>5
  OR (SELECT job_id FROM fu33_builds ORDER BY n LIMIT 1)<>md5('ZZTEST-FU33-12000')::uuid THEN
  RAISE EXCEPTION 'FU33 five fast builds or real-first build failed: %',result; END IF;
 IF result->>'left'<>'1000' OR result->>'left_capped'<>'true' THEN RAISE EXCEPTION 'FU33 count not capped: %',result; END IF;
 -- Explain the actual trailing-count statement copied out of the shipped body.
 SELECT substring(prosrc FROM 'WITH events AS MATERIALIZED(.+?)INTO v_left,v_capped FROM due;') INTO q
 FROM pg_proc WHERE oid='public.job_pages_refresh_due(integer)'::regprocedure;
 q:='WITH events AS MATERIALIZED'||q||' FROM due';
 EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) '||q INTO p;
 IF jsonb_path_exists(p,'$.** ? (@."Node Type" == "Seq Scan" && (@."Relation Name" == "job_change_mark_events" || @."Relation Name" == "job_change_marks_base" || @."Relation Name" == "jobs"))')
  OR jsonb_path_exists(p,'$.** ? ((@."Relation Name" == "job_change_mark_events" || @."Relation Name" == "job_change_marks_base") && @."Actual Rows" > 1001)') THEN
  RAISE EXCEPTION 'FU33 trailing count unbounded: %',p; END IF;
 RAISE NOTICE 'FU33 count plan: %',p;
END $five$;
DO $zero$ DECLARE before_n integer; BEGIN
 SELECT count(*) INTO before_n FROM fu33_builds;
 PERFORM public.job_pages_refresh_due(0);
 PERFORM public.job_pages_refresh_due(-5);
 IF (SELECT count(*) FROM fu33_builds)<>before_n THEN RAISE EXCEPTION 'FU33 nonpositive limit built work'; END IF;
END $zero$;
SAVEPOINT office_change;
SELECT public.job_mark_changed(md5('ZZTEST-FU33-12000')::uuid,'invoice');
SELECT set_config('fu33.during','on',true);
SELECT public.job_pages_refresh_due(1);
DO $office$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.job_change_mark_events WHERE job_id=md5('ZZTEST-FU33-12000')::uuid AND page_pending AND source='invoice') THEN
  RAISE EXCEPTION 'FU33 office change during build was swallowed'; END IF;
END $office$;
ROLLBACK TO office_change;
-- A read failure is still a failed build, yields for a later run, and does not
-- hide completed work. Repeated refusal is never retried twice in this run.
SELECT set_config('fu33.fail','on',true);
DO $fail$ DECLARE result jsonb; BEGIN
 result:=public.job_pages_refresh_due(2);
 IF result->>'failed'<>'1' OR result->>'refreshed'<>'0' THEN RAISE EXCEPTION 'FU33 failed counts: %',result; END IF;
END $fail$;
SELECT set_config('fu33.fail','off',true);
DO $retry$ DECLARE result jsonb; BEGIN
 result:=public.job_pages_refresh_due(1);
 IF result->>'refreshed'<>'1' THEN RAISE EXCEPTION 'FU33 refused build could not be retried: %',result; END IF;
END $retry$;
-- Runner lock remains the original transaction lock, including across calls.
CREATE EXTENSION IF NOT EXISTS dblink;
SELECT dblink_connect('fu33_lock',format('host=127.0.0.1 port=%s dbname=%L user=%L',current_setting('port'),current_database(),current_user));
DO $mutex$ DECLARE result jsonb; BEGIN
 SELECT answer INTO result FROM dblink('fu33_lock','SELECT public.job_pages_refresh_due(5)') AS t(answer jsonb);
 IF result->>'outcome'<>'busy' THEN RAISE EXCEPTION 'FU33 concurrent runner admitted: %',result; END IF;
END $mutex$;
SELECT dblink_disconnect('fu33_lock');
ROLLBACK TO plan_population;
-- Profit flag proof uses the real main profit engine, not a financial stand-in.
INSERT INTO public.jobs(id,org_id,type,status,job_number,metadata,pricing_json,created_at) VALUES
 ('f0330000-0000-4000-8000-000000000002','f0330000-0000-4000-8000-000000000001','fencing','complete','ZZTEST-FU33-PROFIT','{}','{}','2026-06-01');
SET LOCAL secureworks.job_profit_no_page_mark='on';
SET LOCAL statement_timeout='120s';
CREATE TEMP TABLE fu33_quiet_result AS SELECT public.job_profit_refresh('f0330000-0000-4000-8000-000000000002') AS result;
DO $no_mark$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.job_profit_stored WHERE job_id='f0330000-0000-4000-8000-000000000002')
  OR EXISTS(SELECT 1 FROM public.job_change_mark_events WHERE job_id='f0330000-0000-4000-8000-000000000002' AND source='profit') THEN
  RAISE EXCEPTION 'FU33 no-mark first fill queued or failed to store'; END IF;
END $no_mark$;
CREATE TEMP TABLE fu33_quiet_figures AS SELECT to_jsonb(s)-'computed_at' AS figures FROM public.job_profit_stored s WHERE job_id='f0330000-0000-4000-8000-000000000002';
-- A manual business change is still marked while refill suppression is active.
SELECT public.job_mark_changed('f0330000-0000-4000-8000-000000000002','invoice');
DO $manual$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.job_change_mark_events WHERE job_id='f0330000-0000-4000-8000-000000000002' AND source='invoice') THEN RAISE EXCEPTION 'FU33 swallowed manual mark'; END IF;
END $manual$;
-- The source helper dirties stored profit only. It never adds another page
-- mark before the changed-figure refresh, even when the source switch is on.
INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('job_profit_refresh_v1',true,'ZZTEST')
 ON CONFLICT(flag_name) DO UPDATE SET enabled=true;
DO $source_marks$ DECLARE before_n bigint; BEGIN
 SELECT count(*) INTO before_n FROM public.job_change_mark_events WHERE job_id='f0330000-0000-4000-8000-000000000002';
 PERFORM public.job_profit_source_changed('jobs',NULL,'{"id":"f0330000-0000-4000-8000-000000000002"}','job');
 IF (SELECT count(*) FROM public.job_change_mark_events WHERE job_id='f0330000-0000-4000-8000-000000000002')<>before_n
  OR NOT EXISTS(SELECT 1 FROM public.job_profit_change_events WHERE job_id='f0330000-0000-4000-8000-000000000002') THEN
  RAISE EXCEPTION 'FU33 source helper queued a page or lost profit dirtiness'; END IF;
END $source_marks$;
-- Default/off preserves main's existing changed-row marking, including missing
-- stored data. Unchanged figures do not mark a second time.
SET LOCAL secureworks.job_profit_no_page_mark='off';
DELETE FROM public.job_profit_stored WHERE job_id='f0330000-0000-4000-8000-000000000002';
SET LOCAL statement_timeout='120s';
CREATE TEMP TABLE fu33_default_result AS SELECT public.job_profit_refresh('f0330000-0000-4000-8000-000000000002') AS result;
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh('f0330000-0000-4000-8000-000000000002');
DO $default_mark$ BEGIN
 IF (SELECT result-'ms' FROM fu33_quiet_result) IS DISTINCT FROM (SELECT result-'ms' FROM fu33_default_result)
  OR (SELECT figures FROM fu33_quiet_figures) IS DISTINCT FROM (SELECT to_jsonb(s)-'computed_at' FROM public.job_profit_stored s WHERE job_id='f0330000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'FU33 quiet fill changed stored figures or counts'; END IF;
 IF (SELECT count(*) FROM public.job_change_mark_events WHERE job_id='f0330000-0000-4000-8000-000000000002' AND source='profit')<>1 THEN RAISE EXCEPTION 'FU33 default mark drift'; END IF;
END $default_mark$;
-- Slow builds stop the run before a second build starts after the 40s budget.
SAVEPOINT slow_build;
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('f0330000-0000-4000-8000-000000000003','f0330000-0000-4000-8000-000000000001','fencing','accepted','ZZTEST-FU33-SLOW');
SELECT public.job_mark_changed('f0330000-0000-4000-8000-000000000003','status');
CREATE TEMP TABLE fu33_slow_count(n integer);
CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $slow$
BEGIN
 INSERT INTO fu33_slow_count VALUES(1); PERFORM pg_sleep(40.1);
 UPDATE public.job_change_mark_events SET page_pending=false WHERE job_id=p_job_id;
 UPDATE public.job_change_marks_base SET page_pending=false WHERE job_id=p_job_id;
 RETURN '{"outcome":"built"}';
END $slow$;
DO $budget$ DECLARE result jsonb; BEGIN
 result:=public.job_pages_refresh_due(5);
 IF result->>'refreshed'<>'1' OR (SELECT count(*) FROM fu33_slow_count)<>1 THEN RAISE EXCEPTION 'FU33 started build after budget: %',result; END IF;
END $budget$;
ROLLBACK TO slow_build;
-- Undo is tested and put back inside the transaction, never left on the shard.
\ir ../../../rollbacks/20261118055951_job_pages_real_changes_first_down.sql
DO $down$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_pages_next_due()'::regprocedure)<>'d35be2589fd0d6009ae964c277eb8ed1' THEN RAISE EXCEPTION 'FU33 rollback'; END IF;
END $down$;
\ir ../../../migrations/20261118055951_job_pages_real_changes_first.sql
ROLLBACK;
\echo FU33 contract passed: 16 behaviour groups, 2 native indexed plans, renderer preserved, rollback restored
