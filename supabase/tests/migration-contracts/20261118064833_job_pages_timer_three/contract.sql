BEGIN;
-- Recreate the historical queue storage while retaining the current runner
-- and renderer. All definitions and fixtures are restored at transaction end.
CREATE TEMP TABLE fu33_definitions AS
 SELECT pg_get_functiondef(f) AS definition FROM unnest(ARRAY[
 'public.job_pages_refresh_due(integer)'::regprocedure,
 'public.job_page_refresh(uuid)'::regprocedure]) AS f;
\ir ../../../migrations/20261117172503_job_pages_queue_safety.sql
DO $restore$ DECLARE f text; BEGIN
 FOR f IN SELECT definition FROM fu33_definitions LOOP EXECUTE f; END LOOP;
END $restore$;
\ir ../../../migrations/20261117171305_job_pages_schedule.sql

-- Only the pg_cron catalog/API is simulated. Execute the timer's stored SQL.
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint PRIMARY KEY, jobname text, database text DEFAULT current_database(),
 command text, active boolean, schedule text);
CREATE FUNCTION cron.alter_job(job_id bigint,command text) RETURNS void LANGUAGE sql AS $stub$
 UPDATE cron.job SET command=$2 WHERE jobid=$1
$stub$;
INSERT INTO cron.job(jobid,jobname,command,active,schedule) VALUES
 (11,'job-pages-refresh',$cmd$SET LOCAL statement_timeout = '45s'; SELECT public.job_pages_refresh_due(1);$cmd$,false,'* * * * *'),
 (12,'job-pages-nightly','SELECT public.job_pages_nightly(200);',true,'10 18 * * *');
\ir ../../../migrations/20261118064833_job_pages_timer_three.sql
\ir ../../../migrations/20261118064833_job_pages_timer_three.sql
DO $timer$ BEGIN
 IF NOT EXISTS(SELECT FROM cron.job WHERE jobid=11 AND NOT active AND schedule='* * * * *'
  AND command=$cmd$SET LOCAL statement_timeout = '100s'; SELECT public.job_pages_refresh_due(3);$cmd$
  AND strpos(pg_get_functiondef('public.job_pages_install()'::regprocedure),command)>0)
  OR NOT EXISTS(SELECT FROM cron.job WHERE jobid=12 AND active AND schedule='10 18 * * *'
   AND command='SELECT public.job_pages_nightly(200);') THEN RAISE EXCEPTION 'wrong timer change'; END IF;
END $timer$;

UPDATE public.job_change_mark_events SET page_pending=false WHERE page_pending;
UPDATE public.job_change_marks_base SET page_pending=false WHERE page_pending;
INSERT INTO public.organisations(id,name) VALUES('f0330000-0000-4000-8000-000000000002','ZZTEST');
INSERT INTO public.jobs(id,org_id,type,status,job_number)
 SELECT md5('fu33timer'||n)::uuid,'f0330000-0000-4000-8000-000000000002','fencing','accepted','ZZTEST-FU33P2-'||n
 FROM generate_series(1,3) n;
INSERT INTO public.job_change_mark_events(job_id,source,marked_at)
 SELECT md5('fu33timer'||n)::uuid,'status','2026-01-01'::date+n FROM generate_series(1,3) n;
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL,p_since timestamptz DEFAULT NULL,p_record_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $stub$ BEGIN
 IF p_job_id=md5('fu33timer1')::uuid THEN
  IF current_setting('fu33timer.cancel',true)='yes' THEN RAISE query_canceled; END IF;
  PERFORM pg_sleep(40.1);
 END IF;
 RETURN '{"now":{},"loops":[]}';
END $stub$;
CREATE OR REPLACE FUNCTION public.context_job_story_text_get(p_job_id uuid,p_card jsonb DEFAULT NULL,p_check boolean DEFAULT true)
RETURNS jsonb LANGUAGE sql AS $stub$ SELECT '{}'::jsonb $stub$;
SELECT command FROM cron.job WHERE jobid=11 \gexec
DO $first$ BEGIN
 IF NOT EXISTS(SELECT FROM public.job_pages WHERE job_id=md5('fu33timer1')::uuid AND status='ready' AND build_ms>=40000)
 OR EXISTS(SELECT FROM public.job_pages WHERE job_id IN(md5('fu33timer2')::uuid,md5('fu33timer3')::uuid))
 OR (SELECT count(DISTINCT job_id) FROM public.job_change_mark_events WHERE page_pending
   AND job_id IN(md5('fu33timer2')::uuid,md5('fu33timer3')::uuid))<>2 THEN
  RAISE EXCEPTION 'slow success or deferred work missing'; END IF;
END $first$;
SELECT command FROM cron.job WHERE jobid=11 \gexec
DO $second$ BEGIN
 IF (SELECT count(*) FROM public.job_pages WHERE status='ready'
  AND job_id IN(md5('fu33timer1')::uuid,md5('fu33timer2')::uuid,md5('fu33timer3')::uuid))<>3
 OR public.job_pages_next_due() IS NOT NULL THEN RAISE EXCEPTION 'second run failed to finish'; END IF;
END $second$;
-- Cancellation in the renderer's own subtransaction still records the failure
-- while the two other pages complete within this run.
SET LOCAL fu33timer.cancel='yes';
INSERT INTO public.job_change_mark_events(job_id,source,marked_at)
 SELECT md5('fu33timer'||n)::uuid,'invoice','2026-01-01'::date+n FROM generate_series(1,3) n;
DO $failure$ DECLARE r jsonb; BEGIN
 r:=public.job_pages_refresh_due(3);
 IF r->>'refreshed' IS DISTINCT FROM '2' OR r->>'failed' IS DISTINCT FROM '1'
 OR NOT EXISTS(SELECT FROM public.job_pages WHERE job_id=md5('fu33timer1')::uuid AND status='failed' AND error LIKE '57014 %')
 THEN RAISE EXCEPTION 'bad cancellation isolation %',r; END IF;
END $failure$;
\ir ../../../rollbacks/20261118064833_job_pages_timer_three_down.sql
DO $down$ BEGIN
 IF NOT EXISTS(SELECT FROM cron.job WHERE jobid=11 AND NOT active AND
   command=$cmd$SET LOCAL statement_timeout = '45s'; SELECT public.job_pages_refresh_due(1);$cmd$
   AND strpos(pg_get_functiondef('public.job_pages_install()'::regprocedure),command)>0)
 THEN RAISE EXCEPTION 'rollback failed'; END IF;
END $down$;
-- A hand-edited command refuses the migration atomically and survives a retry.
UPDATE cron.job SET command='SELECT 1' WHERE jobid=11;
SAVEPOINT drift;
\set ON_ERROR_STOP off
\ir ../../../migrations/20261118064833_job_pages_timer_three.sql
\set drift_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO drift;
SELECT set_config('fu33timer.drift_state', :'drift_state', true);
DO $drift$ BEGIN
 IF current_setting('fu33timer.drift_state')<>'P0001'
  OR NOT EXISTS(SELECT FROM cron.job WHERE jobid=11 AND command='SELECT 1')
  OR strpos(pg_get_functiondef('public.job_pages_install()'::regprocedure),'refresh_due(1)')=0
 THEN RAISE EXCEPTION 'hand-edited timer or installer was overwritten'; END IF;
END $drift$;
DELETE FROM cron.job WHERE jobid=11;
\ir ../../../migrations/20261118064833_job_pages_timer_three.sql
DO $missing$ BEGIN
 IF EXISTS(SELECT FROM cron.job WHERE jobname='job-pages-refresh') THEN RAISE EXCEPTION 'removed timer recreated'; END IF;
END $missing$;
ROLLBACK;
\echo FU33 timer contract passed: schedule, slow success, next run, cancellation, rollback, command drift, removed install
