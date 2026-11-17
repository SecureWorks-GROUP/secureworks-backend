DO $check$
BEGIN
  IF pg_get_indexdef(to_regclass('public.job_change_mark_events_worker_newest')) IS DISTINCT FROM
    'CREATE INDEX job_change_mark_events_worker_newest ON public.job_change_mark_events USING btree (marked_at DESC) INCLUDE (job_id)'
    OR pg_get_indexdef(to_regclass('public.job_change_marks_base_worker_newest')) IS DISTINCT FROM
    'CREATE INDEX job_change_marks_base_worker_newest ON public.job_change_marks_base USING btree (last_marked_at DESC)' THEN
    RAISE EXCEPTION 'MAIN-RED: rollback did not restore both original index definitions';
  END IF;
END $check$;
\echo PASS: MAIN-RED rollback restores both original index definitions
