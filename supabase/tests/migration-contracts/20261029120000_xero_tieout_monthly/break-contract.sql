-- Deliberately break the holding-job rule: a row on a holding job
-- (do_not_schedule 'true' or '1', any case) is read as on a job. The contract
-- must fail, because a holding job is never a job and its dollars are unplaced.
DO $$
DECLARE d text := pg_get_functiondef('public.xero_tieout_monthly(date,integer,uuid)'::regprocedure);
BEGIN
  IF position('lower(COALESCE(j.metadata ->> ''do_not_schedule'', '''')) IN (''true'', ''1'') AS hold' IN d) = 0 THEN
    RAISE EXCEPTION 'break: holding rule not found';
  END IF;
  EXECUTE replace(d, 'lower(COALESCE(j.metadata ->> ''do_not_schedule'', '''')) IN (''true'', ''1'') AS hold',
                     'lower(COALESCE(j.metadata ->> ''do_not_schedule'', '''')) IN (''never'') AS hold');
END $$;
