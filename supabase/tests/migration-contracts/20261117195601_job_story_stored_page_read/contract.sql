BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags
  WHERE flag_name='job_story_stored_page_v1' AND enabled=false) THEN
  RAISE EXCEPTION 'stored story read must be seeded off';
 END IF;
END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_story_stored_page_v1';
\ir ../../../migrations/20261117195601_job_story_stored_page_read.sql
\ir ../../../migrations/20261117195601_job_story_stored_page_read.sql
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags
  WHERE flag_name='job_story_stored_page_v1' AND enabled=true) THEN
  RAISE EXCEPTION 'stored story read replay changed the operator setting';
 END IF;
END $$;
SELECT 'PASS: P0-02.3 stored story read seeded off; two reapplies preserve setting' AS result;
ROLLBACK;
