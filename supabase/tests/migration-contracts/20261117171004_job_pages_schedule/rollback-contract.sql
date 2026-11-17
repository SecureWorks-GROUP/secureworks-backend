DO $c$
BEGIN
 IF to_regprocedure('public.job_pages_nightly(integer)') IS NOT NULL
  OR to_regprocedure('public.job_pages_keep_ready_set()') IS NOT NULL THEN
  RAISE EXCEPTION 'job pages schedule rollback: schedule function remains';
 END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname IN ('job-pages-refresh','job-pages-nightly')) THEN
   RAISE EXCEPTION 'job pages schedule rollback: cron remains';
  END IF;
 END IF;
 IF to_regprocedure('public.job_page_refresh(uuid)') IS NULL OR to_regclass('public.job_pages') IS NULL THEN
  RAISE EXCEPTION 'job pages schedule rollback: page refresh and table must remain';
 END IF;
END $c$;
