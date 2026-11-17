-- Real advisory-lock contention. Remote session uses this disposable server,
-- never the machine's default database/socket.
CREATE EXTENSION IF NOT EXISTS dblink;
SELECT dblink_connect('page_busy',format('host=127.0.0.1 port=%s dbname=%L user=%L',
 current_setting('port'),current_database(),current_user));
SELECT dblink_exec('page_busy',$remote$DO $lock$ BEGIN
 PERFORM pg_advisory_lock(20261118,hashtext('00000000-0000-4000-8000-000000000471'));
END $lock$;$remote$);
BEGIN;
-- Isolate this queue test from marks other historical contracts leave behind.
UPDATE public.job_change_mark_events SET page_pending=false WHERE page_pending;
UPDATE public.job_change_marks_base SET page_pending=false WHERE page_pending;
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('00000000-0000-4000-8000-000000000471','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-471'),
 ('00000000-0000-4000-8000-000000000472','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-472');
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL,p_since timestamptz DEFAULT NULL,p_record_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql VOLATILE AS $card$ SELECT '{"loops":[],"now":{}}'::jsonb $card$;
-- Legacy pending storage must yield too, without claiming page completion.
INSERT INTO public.job_change_marks_base(job_id,sources)
VALUES('00000000-0000-4000-8000-000000000471',ARRAY['message']);
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000472','message');
DO $c$
DECLARE result jsonb;
BEGIN
 result:=public.job_pages_refresh_due(1);
 IF result->>'refreshed'<>'0' OR public.job_pages_next_due() IS DISTINCT FROM '00000000-0000-4000-8000-000000000472'::uuid THEN
  RAISE EXCEPTION 'page retry: busy head did not pass the turn: %',result;
 END IF;
 IF EXISTS(SELECT 1 FROM public.job_page_marks_seen WHERE job_id='00000000-0000-4000-8000-000000000471')
  OR EXISTS(SELECT 1 FROM public.job_pages WHERE job_id='00000000-0000-4000-8000-000000000471') THEN
  RAISE EXCEPTION 'page retry: busy build claimed page completion';
 END IF;
 result:=public.job_pages_refresh_due(1);
 IF result->>'refreshed'<>'1' OR NOT EXISTS(SELECT 1 FROM public.job_pages
  WHERE job_id='00000000-0000-4000-8000-000000000472' AND status='ready') THEN
  RAISE EXCEPTION 'page retry: second job not built on next run: %',result;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_change_mark_events
  WHERE job_id='00000000-0000-4000-8000-000000000471' AND page_pending AND source='page_retry') THEN
  RAISE EXCEPTION 'page retry: busy job lost its pending work';
 END IF;
END $c$;
SELECT dblink_exec('page_busy',$remote$DO $unlock$ BEGIN
 PERFORM pg_advisory_unlock(20261118,hashtext('00000000-0000-4000-8000-000000000471'));
END $unlock$;$remote$);
DO $c$
BEGIN
 IF public.job_pages_refresh_due(1)->>'refreshed'<>'1'
  OR public.job_page_get('00000000-0000-4000-8000-000000000471')->>'stale'<>'false' THEN
  RAISE EXCEPTION 'page retry: busy job never completed after lock release';
 END IF;
END $c$;
-- A mark arriving during the build changes the observed coordinate. Keep the
-- prior stored page and acknowledgement, and retry after the second marked job.
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000471','message');
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000472','message');
CREATE TEMP TABLE retry_page_before ON COMMIT DROP AS SELECT page,covers_mark_version FROM public.job_pages
 WHERE job_id='00000000-0000-4000-8000-000000000471';
CREATE TEMP TABLE retry_seen_before ON COMMIT DROP AS SELECT * FROM public.job_page_marks_seen
 WHERE job_id='00000000-0000-4000-8000-000000000471';
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL,p_since timestamptz DEFAULT NULL,p_record_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $card$
BEGIN
 IF p_job_id='00000000-0000-4000-8000-000000000471' THEN
  PERFORM public.job_mark_changed(p_job_id,'booking');
 END IF;
 RETURN '{"loops":[],"now":{}}'::jsonb;
END $card$;
DO $c$
DECLARE result jsonb;
BEGIN
 result:=public.job_page_refresh('00000000-0000-4000-8000-000000000471');
 IF result->>'outcome'<>'changed' OR public.job_pages_next_due() IS DISTINCT FROM '00000000-0000-4000-8000-000000000472'::uuid THEN
  RAISE EXCEPTION 'page retry: changed head did not pass the turn: %',result;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_pages p,retry_page_before b
   WHERE p.job_id='00000000-0000-4000-8000-000000000471' AND p.page=b.page AND p.covers_mark_version=b.covers_mark_version)
  OR EXISTS((SELECT * FROM public.job_page_marks_seen WHERE job_id='00000000-0000-4000-8000-000000000471') EXCEPT SELECT * FROM retry_seen_before)
  OR public.job_page_get('00000000-0000-4000-8000-000000000471')->>'stale'<>'true' THEN
  RAISE EXCEPTION 'page retry: changed build replaced the page or hid pending work';
 END IF;
 IF public.job_pages_refresh_due(1)->>'refreshed'<>'1' THEN
  RAISE EXCEPTION 'page retry: second job not built after changed head';
 END IF;
 IF has_function_privilege('anon','public.job_page_yield(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.job_page_yield(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'page retry: browser permission widened';
 END IF;
END $c$;
-- Folding handled marks must not consume the explicit retry.
SELECT public.job_change_marks_fold(10000);
DO $c$ BEGIN
 IF public.job_pages_next_due() IS DISTINCT FROM '00000000-0000-4000-8000-000000000471'::uuid THEN
  RAISE EXCEPTION 'page retry: compaction consumed pending retry'; END IF;
END $c$;
ROLLBACK;
SELECT dblink_disconnect('page_busy');
