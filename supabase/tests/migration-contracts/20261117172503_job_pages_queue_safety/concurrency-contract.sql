-- Real sessions, no error swallowing: each writer keeps its first mark uncommitted
-- while writing the other's job. Both second writes must finish before either commits.
CREATE EXTENSION IF NOT EXISTS dblink;
CREATE TEMP TABLE queue_saved_story AS SELECT pg_get_functiondef(
 'public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'::regprocedure) AS body;
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('00000000-0000-4000-8000-000000000454','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-454'),
 ('00000000-0000-4000-8000-000000000455','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-455');
SELECT dblink_connect('mark_a',format('dbname=%L user=%L',current_database(),current_user));
SELECT dblink_connect('mark_b',format('dbname=%L user=%L',current_database(),current_user));
SELECT dblink_exec('mark_a',$tx$BEGIN; SET LOCAL lock_timeout='200ms'; SET LOCAL statement_timeout='2s'$tx$);
SELECT dblink_exec('mark_b',$tx$BEGIN; SET LOCAL lock_timeout='200ms'; SET LOCAL statement_timeout='2s'$tx$);
SELECT dblink_exec('mark_a',$q$DO $w$ BEGIN PERFORM public.job_mark_changed('00000000-0000-4000-8000-000000000454','message'); END $w$;$q$);
SELECT dblink_exec('mark_b',$q$DO $w$ BEGIN PERFORM public.job_mark_changed('00000000-0000-4000-8000-000000000455','message'); END $w$;$q$);
SELECT dblink_exec('mark_a',$q$DO $w$ BEGIN PERFORM public.job_mark_changed('00000000-0000-4000-8000-000000000455','invoice'); END $w$;$q$);
SELECT dblink_exec('mark_b',$q$DO $w$ BEGIN PERFORM public.job_mark_changed('00000000-0000-4000-8000-000000000454','invoice'); END $w$;$q$);
-- Commit the higher sequence first, build its page, then commit the lower sequence.
SELECT dblink_exec('mark_b','COMMIT');
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL,p_since timestamptz DEFAULT NULL,p_record_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $card$
 SELECT '{"loops":[],"now":{}}'::jsonb
$card$;
SELECT public.job_page_refresh('00000000-0000-4000-8000-000000000454');
-- Fold the committed handled mark while a lower sequence remains uncommitted.
SELECT public.job_change_marks_fold(10000);
SELECT dblink_exec('mark_a','COMMIT');
DO $c$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.job_change_marks m JOIN public.job_page_marks_seen s USING(job_id)
  WHERE job_id='00000000-0000-4000-8000-000000000454' AND m.mark_version<>s.mark_version) THEN
  RAISE EXCEPTION 'queue safety: lower sequence committed late was lost';
 END IF;
 IF (SELECT count(*) FROM public.job_change_mark_events WHERE job_id IN
  ('00000000-0000-4000-8000-000000000454','00000000-0000-4000-8000-000000000455'))
  +coalesce((SELECT sum(folded_event_count) FROM public.job_change_marks_base WHERE job_id IN
  ('00000000-0000-4000-8000-000000000454','00000000-0000-4000-8000-000000000455')),0)<>4 THEN
  RAISE EXCEPTION 'queue safety: opposite-order writer lost a mark';
 END IF;
END $c$;
-- No FK lock: marking a job whose row another business transaction deletes must not wait.
SELECT dblink_exec('mark_a','BEGIN');
SELECT dblink_exec('mark_a',$$DELETE FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000454'$$);
SELECT dblink_exec('mark_b',$tx$BEGIN; SET LOCAL lock_timeout='200ms'$tx$);
SELECT dblink_exec('mark_b',$q$DO $w$ BEGIN PERFORM public.job_mark_changed('00000000-0000-4000-8000-000000000454','booking'); END $w$;$q$);
SELECT dblink_exec('mark_b','COMMIT');
SELECT dblink_exec('mark_a','ROLLBACK');
-- A build that fails after another session marks must acknowledge the pre-build version only.
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL,p_since timestamptz DEFAULT NULL,p_record_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $fault$
BEGIN
 PERFORM dblink_exec('mark_b',$q$DO $w$ BEGIN PERFORM public.job_mark_changed('00000000-0000-4000-8000-000000000455','booking'); END $w$$q$);
 RAISE EXCEPTION 'ZZTEST failure with concurrent mark';
END $fault$;
SELECT public.job_page_refresh('00000000-0000-4000-8000-000000000455');
DO $c$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.job_change_marks m JOIN public.job_page_marks_seen s USING(job_id)
  WHERE job_id='00000000-0000-4000-8000-000000000455' AND m.mark_version<>s.mark_version)
  OR NOT EXISTS(SELECT 1 FROM public.job_pages WHERE job_id='00000000-0000-4000-8000-000000000455'
   AND status='failed' AND error LIKE '%ZZTEST failure with concurrent mark%') THEN
  RAISE EXCEPTION 'queue safety: failure consumed a concurrent mark';
 END IF;
 EXECUTE (SELECT body FROM queue_saved_story);
END $c$;
SELECT dblink_disconnect('mark_a');
SELECT dblink_disconnect('mark_b');
DELETE FROM public.jobs WHERE id IN
 ('00000000-0000-4000-8000-000000000454','00000000-0000-4000-8000-000000000455');
-- Event storage has no parent FK by design. Its projection hides deleted jobs.
DELETE FROM public.job_change_mark_events WHERE job_id IN
 ('00000000-0000-4000-8000-000000000454','00000000-0000-4000-8000-000000000455');
DROP TABLE queue_saved_story;
