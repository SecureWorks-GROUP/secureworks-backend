-- MAIN-RED: both newest-mark readers share the earlier covering indexes.
-- No row, function, trigger, schedule or switch changes.
SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS public.job_change_mark_events_worker_newest;
DROP INDEX IF EXISTS public.job_change_marks_base_worker_newest;
