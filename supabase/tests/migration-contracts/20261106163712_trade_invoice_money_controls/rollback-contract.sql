-- After the down migration: every object is gone, invoices are untouched and
-- a repeated number is accepted again.
DO $$
BEGIN
  IF to_regclass('public.trade_invoice_events') IS NOT NULL
     OR to_regclass('public.trade_invoice_extra_rate_rules') IS NOT NULL
     OR to_regclass('public.trade_invoices_invoice_number_key') IS NOT NULL
     OR to_regprocedure('public.trade_invoice_lines_no_week_claim_guard()') IS NOT NULL
     OR to_regprocedure('public.trade_invoice_no_week_claim_key(uuid, text)') IS NOT NULL
     OR to_regprocedure('public.trade_invoice_events_append_only()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: an object of 20261106163712 survived its down migration';
  END IF;
  IF to_regclass('public.trade_invoices') IS NULL OR to_regclass('public.trade_invoice_lines') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the invoice tables must remain';
  END IF;
END $$;
