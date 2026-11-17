-- Real PostgreSQL sessions: a business write must finish while a build is paused,
-- and after its save while its transaction is still open. No lock-error catches.
-- Only the disposable contract database is used. Kept fixtures are removed below.
CREATE EXTENSION IF NOT EXISTS dblink;
CREATE TEMP TABLE job_page_saved_story AS SELECT pg_get_functiondef(
 'public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'::regprocedure) AS body;
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('00000000-0000-4000-8000-000000000414','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-414');
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000414','message');
SELECT public.job_change_mark_triggers_install();
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL::uuid,p_since timestamptz DEFAULT NULL::timestamptz,p_record_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $gate$
BEGIN
 PERFORM pg_advisory_lock(17171003,1);
 PERFORM pg_advisory_unlock(17171003,1);
 RETURN '{"loops":[],"now":{}}'::jsonb;
END $gate$;
SELECT dblink_connect('page_builder',format('dbname=%L user=%L',current_database(),current_user));
CREATE TEMP TABLE job_page_builder_pid AS
 SELECT pid FROM dblink('page_builder','SELECT pg_backend_pid()') AS t(pid integer);
SELECT dblink_exec('page_builder','BEGIN');
SELECT pg_advisory_lock(17171003,1);
SELECT dblink_send_query('page_builder',
 $$SELECT public.job_page_refresh('00000000-0000-4000-8000-000000000414')$$);
DO $c$
DECLARE i integer;
BEGIN
 FOR i IN 1..500 LOOP
  IF EXISTS (SELECT 1 FROM pg_locks WHERE pid=(SELECT pid FROM job_page_builder_pid)
   AND locktype='advisory' AND NOT granted) THEN RETURN; END IF;
  PERFORM pg_sleep(0.01);
 END LOOP;
 RAISE EXCEPTION 'job pages concurrency: builder never reached the paused build';
END $c$;
-- If the builder locks marks, this real business INSERT fails in 200ms.
BEGIN;
SET LOCAL lock_timeout='200ms';
INSERT INTO public.business_events(id,job_id,event_type,source,channel,payload,metadata)
VALUES ('00000000-0000-4000-8004-000000000414','00000000-0000-4000-8000-000000000414',
 'note','contract','note','{}','{}');
COMMIT;
SELECT pg_advisory_unlock(17171003,1);
CREATE TEMP TABLE job_page_builder_result AS
 SELECT result FROM dblink_get_result('page_builder') AS t(result jsonb);
-- Drain libpq's final empty result before another command.
SELECT result FROM dblink_get_result('page_builder') AS t(result jsonb);
DO $c$
BEGIN
 IF (SELECT result->>'outcome' FROM job_page_builder_result) IS DISTINCT FROM 'changed' THEN
  RAISE EXCEPTION 'job pages concurrency: changed version was saved or acknowledged: %',
   (SELECT result FROM job_page_builder_result);
 END IF;
 IF EXISTS (SELECT 1 FROM public.job_page_marks_seen WHERE job_id='00000000-0000-4000-8000-000000000414') THEN
  RAISE EXCEPTION 'job pages concurrency: a newer mark was cleared';
 END IF;
END $c$;
SELECT dblink_exec('page_builder','COMMIT');
-- This build sees the new version and succeeds, but deliberately does not commit yet.
SELECT dblink_exec('page_builder','BEGIN');
TRUNCATE job_page_builder_result;
INSERT INTO job_page_builder_result
 SELECT result FROM dblink('page_builder',
 $$SELECT public.job_page_refresh('00000000-0000-4000-8000-000000000414')$$) AS t(result jsonb);
DO $c$
BEGIN
 IF (SELECT result->>'outcome' FROM job_page_builder_result) IS DISTINCT FROM 'built' THEN
  RAISE EXCEPTION 'job pages concurrency: second build did not save: %',
   (SELECT result FROM job_page_builder_result);
 END IF;
END $c$;
BEGIN;
SET LOCAL lock_timeout='200ms';
INSERT INTO public.job_documents(id,job_id,type,file_name)
VALUES ('00000000-0000-4000-8003-000000000414','00000000-0000-4000-8000-000000000414','other','ZZTEST-414.pdf');
COMMIT;
SELECT dblink_exec('page_builder','COMMIT');
SELECT dblink_disconnect('page_builder');
DO $c$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_change_marks m JOIN public.job_page_marks_seen s USING (job_id)
  WHERE m.job_id='00000000-0000-4000-8000-000000000414' AND m.mark_version>s.mark_version)
  OR public.job_page_get('00000000-0000-4000-8000-000000000414')->>'stale' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'job pages concurrency: change after save was lost';
 END IF;
 EXECUTE (SELECT body FROM job_page_saved_story);
END $c$;
SELECT public.job_change_mark_triggers_remove();
DELETE FROM public.business_events WHERE id='00000000-0000-4000-8004-000000000414';
DELETE FROM public.job_documents WHERE id='00000000-0000-4000-8003-000000000414';
DELETE FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000414';
DROP TABLE job_page_builder_pid,job_page_builder_result,job_page_saved_story;
