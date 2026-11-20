-- After the down migration the division rulings body is back byte for byte and
-- labour hire has no division in SQL again.
DO $test$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.job_division_option(text,text,uuid)'::regprocedure)
       IS DISTINCT FROM '58669cd21b26a952aa57f2ead2189494'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.job_division_option(text,text)'::regprocedure)
       IS DISTINCT FROM 'c0c72acded3644ca4268f08761f777af'
     OR public.job_division_option('SWLH-ZZTEST01', 'labour_hire') IS DISTINCT FROM ''
     OR public.job_division_option('SWRESTO-ZZTEST01', NULL) IS DISTINCT FROM 'SW - RESTORATION' THEN
    RAISE EXCEPTION 'labour_hire_division_rollback_failed';
  END IF;
END $test$;
