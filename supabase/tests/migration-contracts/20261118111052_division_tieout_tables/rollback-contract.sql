DO $$
BEGIN
  IF to_regclass('public.division_tieout_cells') IS NOT NULL
     OR to_regclass('public.division_tieout_exceptions') IS NOT NULL THEN
    RAISE EXCEPTION 'division_tieout_rollback_incomplete';
  END IF;
END $$;
\echo PASS P3-04.4 empty rollback
