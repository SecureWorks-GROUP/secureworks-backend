-- Contract for 20261117163100_xero_draft_standard (P3-01.1).
\set ON_ERROR_STOP on

-- 1. Both tables exist; the seed is exactly the ten rows of today's codes, unconfirmed; the switch is off.
DO $$
BEGIN
  IF to_regclass('public.xero_tracking_options') IS NULL OR to_regclass('public.xero_account_rules') IS NULL THEN
    RAISE EXCEPTION 'contract: a table is missing';
  END IF;
  IF (SELECT count(*) FROM public.xero_account_rules) <> 10 THEN
    RAISE EXCEPTION 'contract: expected 10 seed rows, found %', (SELECT count(*) FROM public.xero_account_rules);
  END IF;
  IF (SELECT string_agg(source_kind || '/' || line_kind || '=' || account_code, ',' ORDER BY source_kind, line_kind)
        FROM public.xero_account_rules
       WHERE org_id = '00000000-0000-0000-0000-000000000001')
     IS DISTINCT FROM
     'expense_receipt/receipt_job=400,expense_receipt/receipt_stock=400,supplier_bill/default=306,'
     'supplier_credit/default=306,trade_invoice/commission=306,trade_invoice/deduction=306,'
     'trade_invoice/labour=306,trade_invoice/materials=306,trade_invoice/super=306,trade_invoice/travel=306' THEN
    RAISE EXCEPTION 'contract: the seed codes are not today''s: %',
      (SELECT string_agg(source_kind || '/' || line_kind || '=' || account_code, ',' ORDER BY source_kind, line_kind)
         FROM public.xero_account_rules);
  END IF;
  IF EXISTS (SELECT 1 FROM public.xero_account_rules WHERE tax_type IS NOT NULL OR confirmed_at IS NOT NULL OR confirmed_by IS NOT NULL) THEN
    RAISE EXCEPTION 'contract: a seed row carries a tax type or a confirmation';
  END IF;
  IF (SELECT note FROM public.xero_account_rules WHERE source_kind = 'trade_invoice' AND line_kind = 'super')
       IS DISTINCT FROM 'the function uses the TRADE_SUPER_XERO_ACCOUNT_CODE setting when it is set' THEN
    RAISE EXCEPTION 'contract: the super row does not name the setting';
  END IF;
  IF (SELECT count(*) FROM public.xero_tracking_options) <> 0 THEN
    RAISE EXCEPTION 'contract: the option list was filled by the migration';
  END IF;
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'xero_draft_standard_v1' AND enabled = false) <> 1 THEN
    RAISE EXCEPTION 'contract: switch xero_draft_standard_v1 is missing or on';
  END IF;
END $$;

-- 2. Applying twice leaves ten rows and one switch row, and never overwrites a changed or confirmed code
--    or a switch someone turned on.
BEGIN;
UPDATE public.xero_account_rules SET account_code = '999', confirmed_by = 'bookkeeper', confirmed_at = now()
 WHERE source_kind = 'supplier_bill' AND line_kind = 'default';
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'xero_draft_standard_v1';
\ir ../../../migrations/20261117163100_xero_draft_standard.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM public.xero_account_rules) <> 10 THEN
    RAISE EXCEPTION 'contract: a re-apply left % rows', (SELECT count(*) FROM public.xero_account_rules);
  END IF;
  IF (SELECT account_code FROM public.xero_account_rules WHERE source_kind = 'supplier_bill' AND line_kind = 'default') <> '999' THEN
    RAISE EXCEPTION 'contract: a re-apply overwrote a changed code';
  END IF;
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'xero_draft_standard_v1') <> 1
     OR NOT (SELECT enabled FROM public.feature_flags WHERE flag_name = 'xero_draft_standard_v1') THEN
    RAISE EXCEPTION 'contract: a re-apply duplicated or reset the switch';
  END IF;
END $$;
ROLLBACK;

-- 3. A kind outside the allow-lists is refused; a status other than ACTIVE or ARCHIVED is refused.
DO $$
DECLARE refused boolean;
BEGIN
  refused := false;
  BEGIN
    INSERT INTO public.xero_account_rules (org_id, source_kind, line_kind, account_code)
    VALUES ('00000000-0000-0000-0000-000000000001', 'payroll', 'default', '477');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'contract: source_kind payroll was accepted'; END IF;

  refused := false;
  BEGIN
    INSERT INTO public.xero_account_rules (org_id, source_kind, line_kind, account_code)
    VALUES ('00000000-0000-0000-0000-000000000001', 'supplier_bill', 'freight', '306');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'contract: line_kind freight was accepted'; END IF;

  refused := false;
  BEGIN
    INSERT INTO public.xero_tracking_options (org_id, category_id, category_name, option_id, option_name, status)
    VALUES ('00000000-0000-0000-0000-000000000001', 'c1', 'Business Unit', 'o1', 'SW - PATIOS', 'DELETED');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'contract: option status DELETED was accepted'; END IF;
END $$;

-- 4. Service role only: anon and authenticated hold nothing on either table; the service role may
--    select, insert and update; row level security is on with no policy.
DO $$
DECLARE t text; r text; p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.xero_tracking_options', 'public.xero_account_rules'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(r, t, p) THEN
          RAISE EXCEPTION 'contract: % holds % on %', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
      IF NOT has_table_privilege('service_role', t, p) THEN
        RAISE EXCEPTION 'contract: service_role lacks % on %', p, t;
      END IF;
    END LOOP;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN
      RAISE EXCEPTION 'contract: row level security is off on %', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = t::regclass) THEN
      RAISE EXCEPTION 'contract: % has a policy', t;
    END IF;
  END LOOP;
END $$;

-- 5. Role anon cannot read either table.
DO $$
DECLARE refused boolean;
BEGIN
  refused := false;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM 1 FROM public.xero_account_rules LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  RESET ROLE;
  IF NOT refused THEN RAISE EXCEPTION 'contract: anon could select xero_account_rules'; END IF;

  refused := false;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM 1 FROM public.xero_tracking_options LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  RESET ROLE;
  IF NOT refused THEN RAISE EXCEPTION 'contract: anon could select xero_tracking_options'; END IF;
END $$;
