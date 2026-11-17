BEGIN;
DO $check$
BEGIN
  IF to_regclass('public.job_change_mark_events_worker_newest') IS NOT NULL
    OR to_regclass('public.job_change_marks_base_worker_newest') IS NOT NULL THEN
    RAISE EXCEPTION 'MAIN-RED: redundant newest indexes remain';
  END IF;
  IF to_regclass('public.job_change_mark_events_newest') IS NULL
    OR to_regclass('public.job_change_marks_base_newest') IS NULL
    OR to_regclass('public.job_change_mark_events_worker_notes') IS NULL
    OR to_regclass('public.job_change_marks_base_worker_notes') IS NULL THEN
    RAISE EXCEPTION 'MAIN-RED: shared newest or worker notes index lost';
  END IF;
END $check$;
\ir ../../../migrations/20261117221601_job_mark_duplicate_indexes.sql
ROLLBACK;
\echo PASS: MAIN-RED duplicate indexes removed, shared indexes retained, cleanup reapplies
