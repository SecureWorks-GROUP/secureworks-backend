SET LOCAL lock_timeout = '5s';
DO $patch$
DECLARE
  definition text := pg_get_functiondef('public.context_worker_state()'::regprocedure);
  old_notes text := '(SELECT count(*) FROM (SELECT 1 FROM public.job_change_marks m
        WHERE m.notes_done_at IS NULL OR m.last_marked_at > m.notes_done_at LIMIT 50) due_notes)';
  old_newest text := '(SELECT max(m.last_marked_at) FROM public.job_change_marks m)';
/* patch block */ BEGIN
  IF position('public.context_worker_notes_due()' IN definition) > 0
    AND position('public.context_worker_marks_newest()' IN definition) > 0 THEN
    EXECUTE replace(replace(definition, 'public.context_worker_notes_due()', old_notes),
      'public.context_worker_marks_newest()', old_newest);
  ELSIF position(old_notes IN definition) = 0 OR position(old_newest IN definition) = 0 THEN
    RAISE EXCEPTION 'worker mark reads rollback: state pre-image changed';
  END IF;
END $patch$;
DROP FUNCTION IF EXISTS public.context_worker_notes_due();
DROP FUNCTION IF EXISTS public.context_worker_marks_newest();
DROP INDEX IF EXISTS public.job_change_mark_events_worker_newest;
DROP INDEX IF EXISTS public.job_change_marks_base_worker_newest;
DROP INDEX IF EXISTS public.job_change_mark_events_worker_notes;
DROP INDEX IF EXISTS public.job_change_marks_base_worker_notes;
