-- Stand the historical mark/build contract back up; the successor has its own proofs.
-- Roll back this historical schema along with its fixtures, preserving
-- all later table indexes and function bodies for subsequent contracts.
BEGIN;
SELECT to_regclass('public.job_change_marks_base') IS NOT NULL AS queue_safety_live \gset
\if :queue_safety_live
\ir ../../../rollbacks/20261117172503_job_pages_queue_safety_down.sql
\endif
-- P0-01.1: build, consume a mark, then read the same stored page.
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
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000413','message');
DO $c$
DECLARE result jsonb;
BEGIN
 result := public.job_pages_refresh_due(5);
 IF (result->>'refreshed')::integer <> 1 OR (result->>'left')::integer <> 1 THEN
  RAISE EXCEPTION 'job pages: due refresh must build one job per call: %',result;
 END IF;
END $c$;
DO $c$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_change_marks m JOIN public.job_page_marks_seen s USING (job_id)
  WHERE job_id='00000000-0000-4000-8000-000000000412'
  AND s.mark_version=m.mark_version AND s.page_done_at=m.last_marked_at AND s.story_done_at=m.last_marked_at) THEN
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
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL::uuid,p_since timestamptz DEFAULT NULL::timestamptz,p_record_only boolean DEFAULT false)
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
 IF NOT EXISTS (SELECT 1 FROM public.job_change_marks m LEFT JOIN public.job_page_marks_seen s USING (job_id)
  WHERE job_id='00000000-0000-4000-8000-000000000412' AND s.mark_version IS DISTINCT FROM m.mark_version) THEN
  RAISE EXCEPTION 'job pages: failure cleared an unbuilt mark';
 END IF;
END $c$;
ROLLBACK;

-- Concurrent sessions must see committed schema. Run against the unchanged
-- incoming stack after the historical transaction has rolled back.
\ir concurrency-contract.sql
