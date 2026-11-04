-- Prerequisites for 20261104090000_job_cost_crew_and_placement_division: the A6 cost rules before it, applied by the registered walk.
DO $$
BEGIN
  IF to_regprocedure('public.job_cost_super_withheld_line(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'A3 division rule: 20261104071000 is not applied before 20261104090000';
  END IF;
END $$;
