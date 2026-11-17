-- Undo P0-01.2 schedules before removing their functions.
SET LOCAL lock_timeout = '5s';
DO $cron$
DECLARE v_job bigint;
BEGIN
 IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
 FOR v_job IN SELECT jobid FROM cron.job WHERE jobname IN ('job-pages-refresh','job-pages-nightly') LOOP
  PERFORM cron.unschedule(v_job);
 END LOOP;
END $cron$;
DROP FUNCTION IF EXISTS public.job_pages_nightly(integer);
DROP FUNCTION IF EXISTS public.job_pages_keep_ready_set();
