-- Deliberately break the holding-job rule: a row on the holding job
-- (do_not_schedule) is read as on a job. The contract must fail, because a
-- holding job is never a job and its dollars are unplaced.
DO $$
DECLARE d text := pg_get_functiondef('public.xero_tieout_monthly(date,integer)'::regprocedure);
BEGIN
  IF position('= ''true'' AS hold' IN d) = 0 THEN RAISE EXCEPTION 'break: holding rule not found'; END IF;
  EXECUTE replace(d, '= ''true'' AS hold', '= ''never'' AS hold');
END $$;
