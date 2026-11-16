-- Rollback for 20261115143000_job_cost_close.sql. The two read functions store nothing. The status record
-- (job_status_moves) holds every job status move since the migration was applied; dropping it loses that
-- history, which nothing else reads. Drop ops-api's reader first or its cost_close key answers ok:false.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.job_cost_close(uuid[], date);
DROP FUNCTION IF EXISTS public.job_cost_close_policy();
DROP TRIGGER IF EXISTS trg_jobs_record_status_created ON public.jobs;
DROP TRIGGER IF EXISTS trg_jobs_record_status_changed ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_record_status_move();
DROP TABLE IF EXISTS public.job_status_moves;
DROP INDEX IF EXISTS public.job_events_job_created_idx;
