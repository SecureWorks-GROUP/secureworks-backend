-- FU15: real PostgreSQL draw, synthetic jobs only; no installs or external calls.
BEGIN;
CREATE TEMP TABLE fu15_jobs AS
 SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid AS id,n
 FROM generate_series(5501,5520) n;
INSERT INTO public.organisations(id,name) VALUES ('00000000-0000-4000-8000-000000005501','Organisation')
 ON CONFLICT (id) DO NOTHING;
INSERT INTO public.jobs(id,org_id,job_number,type,status)
 SELECT id,'00000000-0000-4000-8000-000000005501','SWTEST-' || n,'fencing','accepted' FROM fu15_jobs;
INSERT INTO public.job_change_mark_events(job_id,marked_at,source)
 SELECT id,now(),'fu15-fixture' FROM fu15_jobs;
INSERT INTO public.job_pages(job_id,page,built_at,build_ms,status)
 SELECT id,'{}',now(),0,'ready' FROM fu15_jobs;
-- Save the real renderer for the timed copy proof below.
CREATE TEMP TABLE fu15_real_refresh AS
 SELECT pg_get_functiondef('public.job_page_refresh(uuid)'::regprocedure) AS body;
CREATE OR REPLACE FUNCTION public.job_pages_keep_ready_set() RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT id FROM pg_temp.fu15_jobs
$$;
CREATE TEMP TABLE fu15_real_notes AS
 SELECT pg_get_functiondef('public.job_truth_notes_of(uuid)'::regprocedure) AS body;
CREATE TEMP TABLE fu15_mode(mode text, bad_job uuid);
INSERT INTO fu15_mode VALUES ('failed','00000000-0000-4000-8000-000000005501');
CREATE TEMP TABLE fu15_attempts(job_id uuid);
CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m text; bad uuid; BEGIN
 SELECT mode,bad_job INTO m,bad FROM pg_temp.fu15_mode;
 INSERT INTO pg_temp.fu15_attempts VALUES(p_job_id);
 IF p_job_id=bad OR m='all_failed' THEN
   IF m='throw' THEN RAISE EXCEPTION 'synthetic refresh fault'; END IF;
   IF m='cancel' THEN RAISE query_canceled USING MESSAGE='synthetic timeout'; END IF;
   IF m='missing' THEN DELETE FROM public.job_pages WHERE job_id=p_job_id;
     RETURN '{"outcome":"built"}'::jsonb; END IF;
   IF m='failed' OR m='all_failed' THEN
     UPDATE public.job_pages SET status='failed' WHERE job_id=p_job_id;
   END IF;
   IF m<>'healthy' THEN RETURN jsonb_build_object('outcome',CASE WHEN m='null' THEN NULL ELSE m END); END IF;
 END IF;
 UPDATE public.job_pages SET status='ready',page=jsonb_build_object('story_text',
   jsonb_build_object('text',jsonb_build_object('sections',jsonb_build_object('headline','Office changed the record.'))))
 WHERE job_id=p_job_id;
 RETURN '{"outcome":"built"}'::jsonb;
END $$;

DO $c$
DECLARE r jsonb; m text; w date := '2027-01-04'; failed boolean := false; BEGIN
 -- Must fail against the original draw. Its one failure used to erase the week.
 BEGIN
   r := public.job_truth_weekly_draw(w,20);
 EXCEPTION WHEN OTHERS THEN failed := true;
 END;
 IF failed OR r->>'jobs'<>'19' OR r->>'skipped'<>'1'
   OR r->'skipped_job_ids'<>'["00000000-0000-4000-8000-000000005501"]'::jsonb
   OR (SELECT count(*) FROM public.job_truth_weekly_samples WHERE week=w)<>19 THEN
   RAISE EXCEPTION 'weekly draw failed-job isolation';
 END IF;
 IF (SELECT count(*) FROM fu15_attempts)<>20 THEN RAISE EXCEPTION 'weekly draw exceeded or lost attempts'; END IF;
 -- A retry preserves the frozen successful sample and does no new refresh work.
 UPDATE fu15_mode SET mode='healthy';
 IF public.job_truth_weekly_draw(w,20)->>'outcome'<>'already_drawn'
   OR (SELECT count(*) FROM fu15_attempts)<>20 THEN RAISE EXCEPTION 'partial draw retry changed kept rows'; END IF;
 -- Throws, cancellation, absent pages and stale ready pages are all local to a job.
 FOREACH m IN ARRAY ARRAY['throw','cancel','missing','busy','changed','no_job','null'] LOOP
   w := w+7;
   UPDATE public.job_pages SET status='ready';
   INSERT INTO public.job_pages(job_id,page,built_at,build_ms,status)
     SELECT id,'{}',now(),0,'ready' FROM fu15_jobs ON CONFLICT(job_id) DO NOTHING;
   UPDATE fu15_mode SET mode=m;
   r := public.job_truth_weekly_draw(w,20);
   IF r->>'jobs'<>'19' OR r->>'skipped'<>'1'
     OR EXISTS (SELECT 1 FROM public.job_truth_weekly_samples WHERE week=w
       AND job_id='00000000-0000-4000-8000-000000005501') THEN
     RAISE EXCEPTION 'weekly draw kept unavailable page for %',m;
   END IF;
 END LOOP;
 -- Empty notes are still empty, and the snapshot reads the office's latest record.
 IF EXISTS (SELECT 1 FROM public.job_truth_weekly_samples WHERE week=w
   AND (notes<>'[]' OR story->0->>'text'<>'Office changed the record.')) THEN
   RAISE EXCEPTION 'weekly draw lost latest record or invented missing notes'; END IF;
 -- Failed note reads roll back only that job, including any snapshot insert.
 EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.job_truth_notes_of(p_generation_id uuid) RETURNS jsonb
 LANGUAGE plpgsql AS $notes$ BEGIN
 IF $1='00000000-0000-4000-8000-000000005501' THEN RAISE EXCEPTION 'synthetic notes read fault'; END IF;
 RETURN '[]'::jsonb; END $notes$$ddl$;
 INSERT INTO public.context_ledger_generations(id,job_id,kind,status,reader,promoted_at)
 VALUES('00000000-0000-4000-8000-000000005501','00000000-0000-4000-8000-000000005501','rebuild','live','fixture',now());
 UPDATE fu15_mode SET mode='healthy';
 UPDATE public.job_pages SET status='ready';
 w:=w+7;
 r:=public.job_truth_weekly_draw(w,20);
 IF r->>'jobs'<>'19' OR r->>'skipped'<>'1' THEN RAISE EXCEPTION 'weekly draw notes read fault erased sample'; END IF;
 DELETE FROM public.context_ledger_generations WHERE id='00000000-0000-4000-8000-000000005501';
 -- All failures keep zero rows; once repaired the same week can be drawn.
 UPDATE fu15_mode SET mode='all_failed';
 w:=w+7;
 r:=public.job_truth_weekly_draw(w,20);
 IF r->>'jobs'<>'0' OR r->>'skipped'<>'20'
   OR EXISTS (SELECT 1 FROM public.job_truth_weekly_samples WHERE week=w) THEN
   RAISE EXCEPTION 'weekly draw invented an all-failed sample'; END IF;
 UPDATE fu15_mode SET mode='healthy';
 UPDATE public.job_pages SET status='ready';
 r:=public.job_truth_weekly_draw(w,20);
 IF r->>'jobs'<>'20' OR r ? 'skipped' THEN RAISE EXCEPTION 'weekly healthy retry changed main response'; END IF;
 IF has_function_privilege('authenticated','public.job_truth_weekly_draw(date,integer)','EXECUTE')
   OR has_function_privilege('anon','public.job_truth_weekly_draw(date,integer)','EXECUTE') THEN
   RAISE EXCEPTION 'weekly draw opened browser access'; END IF;
 RAISE NOTICE 'FU15 behavior: 12 scenarios passed (failed, partial retry, seven unavailable outcomes, latest record/missing notes, notes read fault, all-failed/repaired retry)';
END $c$;
-- Time 20 real page refreshes in one transaction on the synthetic local copy.
-- Restore both real readers. The keep-ready set remains only the 20 fixture ids.
DO $c$ BEGIN
 EXECUTE (SELECT body FROM fu15_real_refresh);
 EXECUTE (SELECT body FROM fu15_real_notes);
END $c$;
UPDATE public.job_pages SET status='ready',page='{}' WHERE job_id IN (SELECT id FROM fu15_jobs);
\ir break-contract.sql
SAVEPOINT fu15_before;
DO $c$
DECLARE t timestamptz := clock_timestamp(); r jsonb; BEGIN
 r:=public.job_truth_weekly_draw('2028-01-03',20);
 IF r->>'jobs'<>'20' THEN RAISE EXCEPTION 'FU15 baseline timing did not refresh 20 jobs'; END IF;
 RAISE NOTICE 'FU15 timing BEFORE: 20 real synthetic page refreshes, one transaction, % ms',
   round(extract(epoch FROM clock_timestamp()-t)*1000,3);
END $c$;
ROLLBACK TO SAVEPOINT fu15_before;
\ir ../../../migrations/20261117205501_job_truth_weekly_skip_failed.sql
DO $c$
DECLARE t timestamptz := clock_timestamp(); r jsonb; BEGIN
 r:=public.job_truth_weekly_draw('2028-01-03',20);
 IF r->>'jobs'<>'20' OR r ? 'skipped' THEN RAISE EXCEPTION 'FU15 timing did not refresh 20 jobs: %',r; END IF;
 RAISE NOTICE 'FU15 timing AFTER: 20 real synthetic page refreshes, one transaction, % ms',
   round(extract(epoch FROM clock_timestamp()-t)*1000,3);
END $c$;
ROLLBACK;
