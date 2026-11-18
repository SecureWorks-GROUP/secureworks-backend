DO $test$ BEGIN
  IF to_regprocedure('public.job_division_option(text,text)') IS NOT NULL
     OR to_regprocedure('public.stock_division_option(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'division_predecessor_rollback_failed';
  END IF;
END $test$;
