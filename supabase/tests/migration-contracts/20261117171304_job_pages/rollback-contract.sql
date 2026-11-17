DO $c$
BEGIN
 IF to_regclass('public.job_pages') IS NOT NULL
  OR to_regprocedure('public.job_page_version()') IS NOT NULL
  OR to_regprocedure('public.job_page_refresh(uuid)') IS NOT NULL
  OR to_regprocedure('public.job_pages_refresh_due(integer)') IS NOT NULL
  OR to_regprocedure('public.job_page_get(uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'job pages rollback: page storage or function remains';
 END IF;
 IF to_regclass('public.job_change_marks') IS NULL OR to_regprocedure('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)') IS NULL THEN
  RAISE EXCEPTION 'job pages rollback: marks and story must remain';
 END IF;
END $c$;
