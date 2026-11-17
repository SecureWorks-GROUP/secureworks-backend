-- A genuine statement timeout in the version read, before the story build.
-- Sequence state survives the cancelled subtransaction, so the handler's retry
-- can read the observed coordinate without another artificial delay.
CREATE TEMP TABLE queue_timeout_saved AS SELECT
 pg_get_viewdef('public.job_change_marks'::regclass,true) AS view_body,
 pg_get_functiondef('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'::regprocedure) AS story_body;
CREATE SEQUENCE public.queue_test_delay_seq;
CREATE FUNCTION public.queue_test_delay(p_job uuid) RETURNS boolean LANGUAGE plpgsql AS $delay$
BEGIN
 IF p_job='00000000-0000-4000-8000-000000000457' AND nextval('public.queue_test_delay_seq')=1 THEN
  PERFORM pg_sleep(1);
 END IF;
 RETURN true;
END $delay$;
DO $c$
BEGIN
 EXECUTE 'CREATE OR REPLACE VIEW public.job_change_marks AS '||
  rtrim((SELECT view_body FROM queue_timeout_saved),E';\n ')||' AND public.queue_test_delay(j.id)';
END $c$;
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL,p_since timestamptz DEFAULT NULL,p_record_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $card$
 SELECT '{"loops":[],"now":{}}'::jsonb
$card$;
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('00000000-0000-4000-8000-000000000457','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-457'),
 ('00000000-0000-4000-8000-000000000458','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-458');
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000457','message');
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000458','message');
SELECT dblink_connect('queue_timeout',format('dbname=%L user=%L',current_database(),current_user));
SELECT dblink_exec('queue_timeout','SET statement_timeout=''200ms''');
CREATE TEMP TABLE queue_timeout_result AS
 SELECT result FROM dblink('queue_timeout','SELECT public.job_pages_refresh_due(1)') AS t(result jsonb);
DO $c$
DECLARE v_second jsonb;
BEGIN
 IF (SELECT result->>'failed' FROM queue_timeout_result) IS DISTINCT FROM '1'
  OR EXISTS(SELECT 1 FROM public.job_change_mark_events
   WHERE job_id='00000000-0000-4000-8000-000000000457' AND page_pending)
  OR NOT EXISTS(SELECT 1 FROM public.job_pages
   WHERE job_id='00000000-0000-4000-8000-000000000457' AND status='failed' AND error LIKE '57014 %') THEN
  RAISE EXCEPTION 'queue safety: real timeout in version read blocked the queue'; END IF;
 -- Separate mutation and readback statements: SQL may evaluate the EXISTS
 -- subplan before a volatile function elsewhere in the same expression.
 v_second:=public.job_pages_refresh_due(1);
 IF v_second->>'refreshed' IS DISTINCT FROM '1'
  OR NOT EXISTS(SELECT 1 FROM public.job_pages
   WHERE job_id='00000000-0000-4000-8000-000000000458' AND status='ready') THEN
  RAISE EXCEPTION 'queue safety: second job blocked after real timeout: %, %',v_second,
   (SELECT error FROM public.job_pages WHERE job_id='00000000-0000-4000-8000-000000000458'); END IF;
 EXECUTE 'CREATE OR REPLACE VIEW public.job_change_marks AS '||(SELECT view_body FROM queue_timeout_saved);
 EXECUTE (SELECT story_body FROM queue_timeout_saved);
END $c$;
SELECT dblink_disconnect('queue_timeout');
DROP FUNCTION public.queue_test_delay(uuid);
DROP SEQUENCE public.queue_test_delay_seq;
DROP TABLE queue_timeout_saved,queue_timeout_result;
DELETE FROM public.jobs WHERE id IN
 ('00000000-0000-4000-8000-000000000457','00000000-0000-4000-8000-000000000458');
DELETE FROM public.job_change_mark_events WHERE job_id IN
 ('00000000-0000-4000-8000-000000000457','00000000-0000-4000-8000-000000000458');

-- Malformed text identifiers skip marking and never fail their business write.
BEGIN;
CREATE TEMP TABLE queue_text_job(job_id text,payload text);
CREATE TRIGGER queue_text_job_mark AFTER INSERT OR UPDATE OR DELETE ON queue_text_job
 FOR EACH ROW EXECUTE FUNCTION public.job_mark_changed_trg('message');
INSERT INTO queue_text_job VALUES('not-a-uuid','first');
UPDATE queue_text_job SET job_id='still-not-a-uuid',payload='second';
DELETE FROM queue_text_job;
DO $c$
BEGIN
 IF EXISTS(SELECT 1 FROM queue_text_job) THEN RAISE EXCEPTION 'queue safety: invalid uuid blocked a business write'; END IF;
END $c$;
ROLLBACK;
