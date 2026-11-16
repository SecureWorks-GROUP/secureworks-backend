-- After the down on an empty copy: the function and both tables are gone, nothing else moved; a second run of the
-- down is a no-op; the migration applies again on top; and a down over tables that hold rows drops the function
-- and keeps the rows.
DO $$
BEGIN
  IF to_regprocedure('public.xero_spend_revenue_monthly(date,integer,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'xero spend revenue rollback: the function is still there';
  END IF;
  IF to_regclass('public.xero_bank_transaction_lines') IS NOT NULL OR to_regclass('public.xero_accounts') IS NOT NULL THEN
    RAISE EXCEPTION 'xero spend revenue rollback: an empty table was left behind';
  END IF;
  IF to_regclass('public.xero_bank_transactions') IS NULL OR to_regclass('public.xero_sync_state') IS NULL THEN
    RAISE EXCEPTION 'xero spend revenue rollback: the down removed a table that is not this migration''s';
  END IF;
END $$;

\ir ../../../rollbacks/20261115110000_xero_spend_revenue_tieout_down.sql
\ir ../../../migrations/20261115110000_xero_spend_revenue_tieout.sql

DO $$
BEGIN
  IF to_regprocedure('public.xero_spend_revenue_monthly(date,integer,uuid)') IS NULL
     OR to_regclass('public.xero_bank_transaction_lines') IS NULL OR to_regclass('public.xero_accounts') IS NULL THEN
    RAISE EXCEPTION 'xero spend revenue rollback: the migration did not apply again after its down';
  END IF;
END $$;

INSERT INTO public.xero_accounts (org_id, xero_account_id, code, name, type, class, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'RB-ACC', '305', 'Direct Material Cost', 'DIRECTCOSTS', 'EXPENSE', 'ACTIVE');
INSERT INTO public.xero_bank_transaction_lines (org_id, xero_txn_id, line_amount_types, line_items)
VALUES ('00000000-0000-0000-0000-000000000001', 'RB-TXN', 'Exclusive', '[{"LineAmount": 1}]');

\ir ../../../rollbacks/20261115110000_xero_spend_revenue_tieout_down.sql

DO $$
BEGIN
  IF to_regprocedure('public.xero_spend_revenue_monthly(date,integer,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'xero spend revenue rollback: the function survived a down over tables that hold rows';
  END IF;
  IF (SELECT count(*) FROM public.xero_accounts) <> 1 OR (SELECT count(*) FROM public.xero_bank_transaction_lines) <> 1 THEN
    RAISE EXCEPTION 'xero spend revenue rollback: the down removed rows read from Xero';
  END IF;
END $$;
