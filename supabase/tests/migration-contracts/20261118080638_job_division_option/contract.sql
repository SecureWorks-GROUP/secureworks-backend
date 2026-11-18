BEGIN;
-- Exercise the predecessor at its own revision, even on a full successor stack.
SELECT to_regprocedure('public.job_division_option(text,text,uuid)') IS NOT NULL AS has_successor \gset
\if :has_successor
\ir ../../../rollbacks/20261118120115_division_rulings_down.sql
\endif
\ir ../../../migrations/20261118080638_job_division_option.sql
DO $test$ BEGIN
  IF public.job_division_option('SWF-ZZTEST', NULL) IS DISTINCT FROM 'SW - FENCING'
     OR public.stock_division_option('insurance') IS DISTINCT FROM 'SW - INSURANCE WORK'
     OR public.job_division_option('SWP-ZZTEST','granny_flat') IS DISTINCT FROM ''
     OR public.stock_division_option('fuel') IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'division_predecessor_mismatch';
  END IF;
END $test$;
ROLLBACK;
