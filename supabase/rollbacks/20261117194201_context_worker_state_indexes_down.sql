SET LOCAL lock_timeout = '5s';
DO $patch$
DECLARE
  definition text := pg_get_functiondef('public.context_worker_state()'::regprocedure);
  old_expression text := 'CASE WHEN EXISTS (SELECT 1 FROM public.context_extraction_candidates(1)) THEN 1 ELSE 0 END';
  new_expression text := 'public.context_worker_facts_present()';
  old_marks text := '(SELECT max(m.last_marked_at) FROM public.job_change_marks m)';
  new_marks text := 'public.context_worker_marks_newest()'; BEGIN
  IF (position(new_expression IN definition) = 0 AND position(old_expression IN definition) = 0)
    OR (position(new_marks IN definition) = 0 AND position(old_marks IN definition) = 0) THEN
    RAISE EXCEPTION 'worker state follow-up rollback: facts pre-image changed';
  END IF;
  EXECUTE replace(replace(definition, new_expression, old_expression), new_marks, old_marks);
END $patch$;
DROP FUNCTION IF EXISTS public.context_worker_facts_present();
DROP FUNCTION IF EXISTS public.context_worker_marks_newest();
DROP INDEX IF EXISTS public.business_events_worker_facts_present;
DROP INDEX IF EXISTS public.context_catchup_jobs_worker_present;
DROP INDEX IF EXISTS public.job_change_marks_base_newest;
DROP INDEX IF EXISTS public.job_change_mark_events_newest;
