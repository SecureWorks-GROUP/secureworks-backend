-- P0-01.2: keep-ready population, missing/current pages and bounded retention.
BEGIN;
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
