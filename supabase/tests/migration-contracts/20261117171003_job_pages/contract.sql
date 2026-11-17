-- P0-01.1: build, consume a mark, then read the same stored page.
BEGIN;
INSERT INTO public.jobs (id,org_id,type,status,job_number) VALUES
 ('00000000-0000-4000-8000-000000000412','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-412'),
 ('00000000-0000-4000-8000-000000000413','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-413');
DO $c$
DECLARE result jsonb;
BEGIN
 result := public.job_page_refresh('00000000-0000-4000-8000-000000000412');
 IF result ->> 'outcome' IS DISTINCT FROM 'built' OR NOT EXISTS (
  SELECT 1 FROM public.job_pages WHERE job_id='00000000-0000-4000-8000-000000000412'
   AND page ->> 'version'='job-page-v1' AND page -> 'summary' ? 'loops') THEN
  RAISE EXCEPTION 'job pages: refresh did not store a built page: %, %',result,
   (SELECT error FROM public.job_pages WHERE job_id='00000000-0000-4000-8000-000000000412');
 END IF;
END $c$;
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000412','message');
SELECT public.job_pages_refresh_due(5);
DO $c$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_change_marks WHERE job_id='00000000-0000-4000-8000-000000000412'
  AND page_done_at=last_marked_at AND story_done_at=last_marked_at) THEN
  RAISE EXCEPTION 'job pages: due refresh did not consume the observed mark';
 END IF;
 IF public.job_page_get('00000000-0000-4000-8000-000000000412') ->> 'stale' IS DISTINCT FROM 'false' THEN
  RAISE EXCEPTION 'job pages: a refreshed page is stale';
 END IF;
END $c$;
CREATE TEMP TABLE page_before ON COMMIT DROP AS SELECT built_at,page,card_hash FROM public.job_pages
 WHERE job_id='00000000-0000-4000-8000-000000000412';
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000412','message');
DO $c$
DECLARE result jsonb;
BEGIN
 result := public.job_page_get('00000000-0000-4000-8000-000000000412');
 IF result ->> 'stale' IS DISTINCT FROM 'true' OR
  (SELECT built_at FROM public.job_pages WHERE job_id='00000000-0000-4000-8000-000000000412')
    IS DISTINCT FROM (SELECT built_at FROM page_before) THEN
  RAISE EXCEPTION 'job pages: read rebuilt a stale page or hid its stale state';
 END IF;
 IF public.job_page_get('00000000-0000-4000-8000-000000000499') IS NOT NULL THEN
  RAISE EXCEPTION 'job pages: unknown job must return null';
 END IF;
 result := public.job_page_get('00000000-0000-4000-8000-000000000413');
 IF result ->> 'kept_ready' IS DISTINCT FROM 'false' OR result ->> 'status' IS DISTINCT FROM 'ready' THEN
  RAISE EXCEPTION 'job pages: first read must build on demand: %',result;
 END IF;
END $c$;
-- Fault injection is scoped to this rolled-back transaction. The prior assertions use real story functions.
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fault$
BEGIN RAISE EXCEPTION 'ZZTEST build failure'; END $fault$;
DO $c$
DECLARE result jsonb;
BEGIN
 result := public.job_page_refresh('00000000-0000-4000-8000-000000000412');
 IF result ->> 'outcome' IS DISTINCT FROM 'failed' OR NOT EXISTS (
  SELECT 1 FROM public.job_pages p CROSS JOIN page_before b
  WHERE p.job_id='00000000-0000-4000-8000-000000000412' AND p.status='failed'
   AND p.page=b.page AND p.card_hash IS NOT DISTINCT FROM b.card_hash AND p.error LIKE '%ZZTEST build failure%') THEN
  RAISE EXCEPTION 'job pages: failure must keep the old page and record the error';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_change_marks WHERE job_id='00000000-0000-4000-8000-000000000412'
  AND page_done_at=last_marked_at) THEN
  RAISE EXCEPTION 'job pages: failure left the observed mark due';
 END IF;
END $c$;
ROLLBACK;
