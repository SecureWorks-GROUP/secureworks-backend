-- After 20261029170100_context_job_bill_outcomes_down.sql: the Context read is
-- gone and CFO's view it read is untouched.
DO $$
BEGIN
  IF to_regprocedure('public.context_job_bill_outcomes(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback left context_job_bill_outcomes';
  END IF;
  IF to_regclass('public.cfo_bill_cost_outcomes') IS NULL THEN
    RAISE EXCEPTION 'rollback took CFO''s view with it';
  END IF;
  PERFORM 1 FROM public.cfo_bill_cost_outcomes LIMIT 1;
END $$;
