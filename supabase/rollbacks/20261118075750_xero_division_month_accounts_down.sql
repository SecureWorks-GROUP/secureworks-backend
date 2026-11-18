SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Retain imported accounts if this is run after the sync starts.
DO $$
BEGIN
  IF to_regclass('public.xero_division_month_accounts') IS NOT NULL THEN
    LOCK TABLE public.xero_division_month_accounts IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT FROM public.xero_division_month_accounts) THEN
      RAISE EXCEPTION 'division_month_accounts_in_use';
    END IF;
    DROP TABLE public.xero_division_month_accounts;
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag_name = 'division_tieout_v1';
