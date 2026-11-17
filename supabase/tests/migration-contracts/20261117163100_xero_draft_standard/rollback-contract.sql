-- After the 20261117163100 rollback: both tables and the switch row are gone, and the switch
-- table itself is untouched.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.xero_tracking_options') IS NOT NULL OR to_regclass('public.xero_account_rules') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a table is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'xero_draft_standard_v1') THEN
    RAISE EXCEPTION 'rollback contract: the switch row is still there';
  END IF;
  PERFORM 1 FROM public.feature_flags LIMIT 1;
END $$;
