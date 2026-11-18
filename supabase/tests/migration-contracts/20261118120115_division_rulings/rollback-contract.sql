DO $test$ BEGIN
  IF to_regprocedure('public.job_division_option(text,text,uuid)') IS NOT NULL
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.job_division_option(text,text)'::regprocedure) IS DISTINCT FROM '3f7f48236215e19085a7ef632a7f47b8'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.stock_division_option(text)'::regprocedure) IS DISTINCT FROM '60fa26bb67c188cd08e3d1f493ef5801' THEN
    RAISE EXCEPTION 'division_rulings_rollback_failed';
  END IF;
END $test$;
