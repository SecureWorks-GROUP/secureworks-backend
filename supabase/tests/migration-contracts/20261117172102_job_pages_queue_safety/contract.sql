-- The failed head must yield to the second job, including a timeout failure.
BEGIN;
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('00000000-0000-4000-8000-000000000451','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-451'),
 ('00000000-0000-4000-8000-000000000452','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-452'),
 ('00000000-0000-4000-8000-000000000453','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-453');
-- Fault only the first and third builds. The second returns a price-free fixture card.
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL,p_since timestamptz DEFAULT NULL,p_record_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $fault$
BEGIN
 IF p_job_id='00000000-0000-4000-8000-000000000451' THEN RAISE EXCEPTION 'ZZTEST build failure'; END IF;
 IF p_job_id='00000000-0000-4000-8000-000000000453' THEN
  RAISE EXCEPTION USING ERRCODE='57014',MESSAGE='ZZTEST timed out';
 END IF;
 RETURN '{"loops":[],"now":{}}'::jsonb;
END $fault$;
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000451','message');
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000452','message');
DO $c$
DECLARE result jsonb;
BEGIN
 result:=public.job_pages_refresh_due(1);
 IF result->>'failed' IS DISTINCT FROM '1' OR result->>'left' IS DISTINCT FROM '1' THEN
  RAISE EXCEPTION 'queue safety: failed head did not yield: %',result;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_page_marks_seen s JOIN public.job_change_marks m USING(job_id)
  WHERE job_id='00000000-0000-4000-8000-000000000451' AND s.mark_version=m.mark_version) THEN
  RAISE EXCEPTION 'queue safety: failed observed version not acknowledged';
 END IF;
 result:=public.job_pages_refresh_due(1);
 IF result->>'refreshed' IS DISTINCT FROM '1' OR result->>'left' IS DISTINCT FROM '0'
  OR NOT EXISTS(SELECT 1 FROM public.job_pages WHERE job_id='00000000-0000-4000-8000-000000000452' AND status='ready') THEN
  RAISE EXCEPTION 'queue safety: second job did not get its page: %',result;
 END IF;
 PERFORM public.job_mark_changed('00000000-0000-4000-8000-000000000453','message');
 result:=public.job_pages_refresh_due(1);
 IF result->>'failed' IS DISTINCT FROM '1' OR result->>'left' IS DISTINCT FROM '0' THEN
  RAISE EXCEPTION 'queue safety: timeout head did not yield: %',result;
 END IF;
 -- Nightly, not every minute, makes failed pages due again.
 PERFORM public.job_pages_nightly(200);
 IF (SELECT count(*) FROM public.job_change_marks m LEFT JOIN public.job_page_marks_seen s USING(job_id)
  WHERE m.job_id IN ('00000000-0000-4000-8000-000000000451','00000000-0000-4000-8000-000000000453')
   AND m.mark_version IS DISTINCT FROM s.mark_version)<>2 THEN
  RAISE EXCEPTION 'queue safety: nightly did not re-mark the failed pages';
 END IF;
END $c$;
-- Multiple appended marks collapse to one read; notes acknowledgements do not erase page work.
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000452','invoice');
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000452','booking');
DO $c$
DECLARE v_until timestamptz:=clock_timestamp(); v_expected integer; v_actual integer;
BEGIN
 IF (SELECT count(*) FROM public.job_change_marks WHERE job_id='00000000-0000-4000-8000-000000000452')<>1
  OR NOT EXISTS(SELECT 1 FROM public.job_change_marks WHERE job_id='00000000-0000-4000-8000-000000000452'
   AND sources=ARRAY['invoice','booking']) THEN RAISE EXCEPTION 'queue safety: append collapse lost sources'; END IF;
 -- Nightly also marks other eligible stack fixtures. Compare with the actual
 -- due population instead of assuming this contract owns the whole database.
 SELECT count(*) INTO v_expected FROM public.job_change_marks
 WHERE last_marked_at<=v_until AND (notes_done_at IS NULL OR last_marked_at>notes_done_at);
 v_actual:=public.job_marks_notes_seen(v_until);
 IF v_actual<>v_expected THEN
  RAISE EXCEPTION 'queue safety: notes acknowledgement differs: expected %, got %',v_expected,v_actual;
 END IF;
 v_actual:=public.job_marks_notes_seen(v_until);
 IF v_actual<>0 THEN RAISE EXCEPTION 'queue safety: notes acknowledgement repeated % rows',v_actual; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND starts_with(tgname,'job_mark_changed_')) THEN
  RAISE EXCEPTION 'queue safety: migration installed a trigger';
 END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname IN ('job-pages-refresh','job-pages-nightly')) THEN
   RAISE EXCEPTION 'queue safety: migration installed a schedule';
  END IF;
 END IF;
 IF has_table_privilege('anon','public.job_change_mark_events','SELECT')
  OR has_table_privilege('authenticated','public.job_change_marks','SELECT')
  OR has_table_privilege('authenticated','public.job_notes_marks_seen','UPDATE') THEN
  RAISE EXCEPTION 'queue safety: browser access widened';
 END IF;
END $c$;
ROLLBACK;
\ir concurrency-contract.sql
