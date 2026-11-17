-- Restore the two redundant indexes exactly as the worker migration created them.
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS job_change_mark_events_worker_newest
  ON public.job_change_mark_events (marked_at DESC) INCLUDE (job_id);
CREATE INDEX IF NOT EXISTS job_change_marks_base_worker_newest
  ON public.job_change_marks_base (last_marked_at DESC);
