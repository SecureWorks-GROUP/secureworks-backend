DO $c$ BEGIN
 IF to_regprocedure('public.job_page_yield(uuid)') IS NOT NULL
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_record_messages(uuid[],timestamptz)'::regprocedure)
    IS DISTINCT FROM 'c2b73175d602d5add3cf19bceeaae7eb'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_page_refresh(uuid)'::regprocedure) IS DISTINCT FROM '9d307590b45a66132143fd5bbc241c93'
  OR position('job_page_yield' IN pg_get_functiondef('public.job_page_refresh(uuid)'::regprocedure))<>0 THEN
  RAISE EXCEPTION 'page speed rollback: predecessor definitions not restored';
 END IF;
END $c$;
