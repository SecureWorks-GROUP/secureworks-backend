-- Stand the historical mark/build contract back up; the successor has its own proofs.
SELECT to_regclass('public.job_change_marks_base') IS NOT NULL AS queue_safety_live \gset
\if :queue_safety_live
\ir ../../../rollbacks/20261117172102_job_pages_queue_safety_down.sql
\endif
-- P0-01.2: keep-ready population, missing/current pages and bounded retention.
BEGIN;
-- The migration itself must leave the busy tables and cron untouched.
DO $c$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND starts_with(tgname,'job_mark_changed_')) THEN
  RAISE EXCEPTION 'job pages install: migration installed a trigger';
 END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname IN ('job-pages-refresh','job-pages-nightly')) THEN
   RAISE EXCEPTION 'job pages install: migration scheduled a job';
  END IF;
 END IF;
 IF has_function_privilege('anon','public.job_pages_install()','EXECUTE')
  OR has_function_privilege('authenticated','public.job_pages_install()','EXECUTE')
  OR has_function_privilege('anon','public.job_pages_remove()','EXECUTE')
  OR has_function_privilege('authenticated','public.job_pages_remove()','EXECUTE')
  OR has_function_privilege('authenticated','public.job_change_mark_triggers_install()','EXECUTE')
  OR has_function_privilege('anon','public.job_change_mark_triggers_remove()','EXECUTE') THEN
  RAISE EXCEPTION 'job pages install: browser role can install or remove';
 END IF;
END $c$;
-- pg_cron is absent from this disposable stack. Test its catalog and API boundary,
-- never an actual timer. These test-only objects roll back with the fixtures.
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text,schedule text,command text);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $stub$
 INSERT INTO cron.job(jobname,schedule,command) VALUES ($1,$2,$3) RETURNING jobid
$stub$;
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $stub$
 WITH d AS (DELETE FROM cron.job WHERE jobid=$1 RETURNING 1) SELECT EXISTS (SELECT 1 FROM d)
$stub$;
SET LOCAL ROLE service_role;
SELECT public.job_pages_install();
RESET ROLE;
DO $c$
BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND starts_with(tgname,'job_mark_changed_')) <> 14
  OR (SELECT count(*) FROM cron.job WHERE jobname IN ('job-pages-refresh','job-pages-nightly')) <> 2 THEN
  RAISE EXCEPTION 'job pages install: expected all 14 triggers and both schedules';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='job-pages-refresh'
  AND command=$cmd$SET LOCAL statement_timeout = '45s'; SELECT public.job_pages_refresh_due(1);$cmd$) THEN
  RAISE EXCEPTION 'job pages install: refresh must use one job per transaction and timeout headroom';
 END IF;
END $c$;
-- Re-install is idempotent, and remove leaves the stored pages/functions intact.
SELECT public.job_pages_install();
DO $c$
BEGIN
 IF (SELECT count(*) FROM cron.job) <> 2 THEN RAISE EXCEPTION 'job pages install: repeated install duplicated schedules'; END IF;
END $c$;
SET LOCAL ROLE service_role;
SELECT public.job_pages_remove();
RESET ROLE;
DO $c$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND starts_with(tgname,'job_mark_changed_'))
  OR EXISTS (SELECT 1 FROM cron.job) OR to_regclass('public.job_pages') IS NULL THEN
  RAISE EXCEPTION 'job pages remove: live hooks remain or pages were removed';
 END IF;
END $c$;
INSERT INTO public.jobs (id,org_id,type,status,job_number,completed_at,updated_at) VALUES
 ('00000000-0000-4000-8000-000000000416','00000000-0000-0000-0000-000000000001','fencing','complete','ZZTEST-416',now()-interval '11 months',now()-interval '11 months'),
 ('00000000-0000-4000-8000-000000000417','00000000-0000-0000-0000-000000000001','fencing','complete','ZZTEST-417',now()-interval '13 months',now()-interval '13 months'),
 ('00000000-0000-4000-8000-000000000418','00000000-0000-0000-0000-000000000001','fencing','scheduled','ZZTEST-418',NULL,now()),
 ('00000000-0000-4000-8000-000000000419','00000000-0000-0000-0000-000000000001','fencing','draft','ZZTEST-419',NULL,now());
DO $c$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_pages_keep_ready_set() AS k(id) WHERE k.id='00000000-0000-4000-8000-000000000416')
  OR NOT EXISTS (SELECT 1 FROM public.job_pages_keep_ready_set() AS k(id) WHERE k.id='00000000-0000-4000-8000-000000000418')
  OR EXISTS (SELECT 1 FROM public.job_pages_keep_ready_set() AS k(id) WHERE k.id IN
   ('00000000-0000-4000-8000-000000000417','00000000-0000-4000-8000-000000000419')) THEN
  RAISE EXCEPTION 'job pages schedule: keep-ready population differs';
 END IF;
END $c$;
INSERT INTO public.job_pages (job_id,page,built_at,build_ms,page_version) VALUES
 ('00000000-0000-4000-8000-000000000418','{"version":"job-page-v1"}',now(),0,public.job_page_version()),
 ('00000000-0000-4000-8000-000000000417','{"version":"job-page-v1"}',now()-interval '8 days',0,public.job_page_version()),
 ('00000000-0000-4000-8000-000000000419','{"version":"job-page-v1"}',now(),0,public.job_page_version());
DELETE FROM public.job_change_marks WHERE job_id IN
 ('00000000-0000-4000-8000-000000000416','00000000-0000-4000-8000-000000000418');
DO $c$
DECLARE result jsonb;
BEGIN
 result := public.job_pages_nightly(200);
 IF (result ->> 'marked')::integer < 1 OR NOT EXISTS (SELECT 1 FROM public.job_change_marks
   WHERE job_id='00000000-0000-4000-8000-000000000416' AND 'status'=ANY(sources)) THEN
  RAISE EXCEPTION 'job pages schedule: missing page was not marked';
 END IF;
 IF EXISTS (SELECT 1 FROM public.job_change_marks WHERE job_id='00000000-0000-4000-8000-000000000418') THEN
  RAISE EXCEPTION 'job pages schedule: current page was marked';
 END IF;
 IF EXISTS (SELECT 1 FROM public.job_pages WHERE job_id='00000000-0000-4000-8000-000000000417')
  OR NOT EXISTS (SELECT 1 FROM public.job_pages WHERE job_id='00000000-0000-4000-8000-000000000419') THEN
  RAISE EXCEPTION 'job pages schedule: deletion did not respect keep-ready set and seven days';
 END IF;
END $c$;
ROLLBACK;

-- Restore the successor for the remaining registered cases.
\ir ../../../migrations/20261117172102_job_pages_queue_safety.sql
