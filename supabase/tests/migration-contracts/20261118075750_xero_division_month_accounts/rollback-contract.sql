DO $$
BEGIN
  IF to_regclass('public.xero_division_month_accounts') IS NOT NULL
     OR EXISTS (SELECT FROM public.feature_flags WHERE flag_name = 'division_tieout_v1') THEN
    RAISE EXCEPTION 'division_rollback_incomplete';
  END IF;
END $$;
\echo PASS P3-04.1 empty rollback
