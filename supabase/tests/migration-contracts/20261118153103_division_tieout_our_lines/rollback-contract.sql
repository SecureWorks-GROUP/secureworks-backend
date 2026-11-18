DO $$
BEGIN
  IF to_regprocedure('public.division_tieout_our_lines(uuid,date)') IS NOT NULL THEN
    RAISE EXCEPTION 'division_tieout_our_lines_rollback_incomplete';
  END IF;
  IF to_regprocedure('public.job_division_option(text,text)') IS NULL
     OR to_regclass('public.job_cost_lines') IS NULL THEN
    RAISE EXCEPTION 'division_tieout_our_lines_rollback_dropped_prerequisite';
  END IF;
END $$;
\echo PASS P3-04.5 rollback drops only division_tieout_our_lines
