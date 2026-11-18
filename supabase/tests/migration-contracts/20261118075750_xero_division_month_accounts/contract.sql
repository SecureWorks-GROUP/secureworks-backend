\set ON_ERROR_STOP on
BEGIN;
\ir ../../../migrations/20261118075750_xero_division_month_accounts.sql

DO $$
DECLARE
  browser_role text;
  privilege text;
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'division_tieout_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'division_switch_seed';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.xero_division_month_accounts'::regclass)
     OR EXISTS (SELECT FROM pg_policy WHERE polrelid = 'public.xero_division_month_accounts'::regclass) THEN
    RAISE EXCEPTION 'division_rls';
  END IF;
  FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege(browser_role, 'public.xero_division_month_accounts', privilege) THEN
        RAISE EXCEPTION 'division_browser_access';
      END IF;
    END LOOP;
  END LOOP;
END $$;

SET LOCAL ROLE service_role;
DO $$
DECLARE
  fixture public.xero_division_month_accounts%ROWTYPE;
  kept numeric;
BEGIN
  fixture := ROW('00000000-0000-0000-0000-000000000041', DATE '2000-01-01',
    'test-option', 'income', 'test-account', 'Test account', 12.34, now());
  INSERT INTO public.xero_division_month_accounts SELECT fixture.*;
  BEGIN
    fixture.section := 'expenses';
    INSERT INTO public.xero_division_month_accounts SELECT fixture.*;
    RAISE EXCEPTION 'division_duplicate_accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  fixture.month := DATE '2000-01-02';
  BEGIN
    INSERT INTO public.xero_division_month_accounts SELECT fixture.*;
    RAISE EXCEPTION 'division_midmonth_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  fixture.month := DATE '2000-02-01';
  fixture.section := 'unknown';
  BEGIN
    INSERT INTO public.xero_division_month_accounts SELECT fixture.*;
    RAISE EXCEPTION 'division_section_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  fixture.section := 'cost_of_sales';
  BEGIN
    fixture.amount := NULL;
    INSERT INTO public.xero_division_month_accounts SELECT fixture.*;
    RAISE EXCEPTION 'division_missing_amount_accepted';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;

  fixture.amount := -1.23;
  INSERT INTO public.xero_division_month_accounts SELECT fixture.*;
  UPDATE public.xero_division_month_accounts SET amount = 0
    WHERE org_id = fixture.org_id AND month = fixture.month
      AND tracking_option = fixture.tracking_option AND account_id = fixture.account_id;
  SELECT amount INTO STRICT kept FROM public.xero_division_month_accounts
    WHERE org_id = fixture.org_id AND month = fixture.month
      AND tracking_option = fixture.tracking_option AND account_id = fixture.account_id;
  IF kept <> 0 THEN RAISE EXCEPTION 'division_explicit_zero'; END IF;
  DELETE FROM public.xero_division_month_accounts
    WHERE org_id = fixture.org_id AND month = fixture.month
      AND tracking_option = fixture.tracking_option AND account_id = fixture.account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'division_service_delete'; END IF;
END $$;
RESET ROLE;

UPDATE public.feature_flags SET description = 'Office edit' WHERE flag_name = 'division_tieout_v1';
\ir ../../../migrations/20261118075750_xero_division_month_accounts.sql
DO $$
BEGIN
  IF (SELECT description FROM public.feature_flags WHERE flag_name = 'division_tieout_v1')
       IS DISTINCT FROM 'Office edit' THEN RAISE EXCEPTION 'division_switch_overwritten'; END IF;
  IF (SELECT amount FROM public.xero_division_month_accounts
      WHERE org_id = '00000000-0000-0000-0000-000000000041' AND month = DATE '2000-01-01'
        AND tracking_option = 'test-option' AND account_id = 'test-account')
       IS DISTINCT FROM 12.34 THEN RAISE EXCEPTION 'division_account_changed'; END IF;
END $$;
ROLLBACK;
\echo PASS P3-04.1 division account constraints, service access and replay
