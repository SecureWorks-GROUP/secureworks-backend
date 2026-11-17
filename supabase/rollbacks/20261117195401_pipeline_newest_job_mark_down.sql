-- FU13: remove only this read and its index. Mark writers and folding stay intact.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.pipeline_newest_job_mark(uuid);
DROP INDEX IF EXISTS public.job_change_mark_events_newest;
DROP INDEX IF EXISTS public.job_change_marks_base_newest;
