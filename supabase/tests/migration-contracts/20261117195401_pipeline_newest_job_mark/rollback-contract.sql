DO $check$ BEGIN
 IF to_regprocedure('public.pipeline_newest_job_mark(uuid)') IS NOT NULL
  OR to_regclass('public.job_change_mark_events_newest') IS NOT NULL THEN
  RAISE EXCEPTION 'FU13: rollback left reader or index'; END IF;
 IF to_regclass('public.job_change_mark_events') IS NULL THEN
  RAISE EXCEPTION 'FU13: rollback removed live marks'; END IF;
END $check$;
