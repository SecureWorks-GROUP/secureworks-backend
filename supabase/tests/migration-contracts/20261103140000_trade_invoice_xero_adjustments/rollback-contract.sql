-- After the down: the three columns, the constraint and the tie function are gone.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'trade_invoices'
         AND column_name IN ('xero_bill_total', 'xero_adjustments_ex', 'xero_adjustment_lines')
     )
     OR to_regprocedure('public.trade_invoice_xero_adjustments_tie(numeric,jsonb)') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.trade_invoices'::regclass
         AND conname = 'trade_invoices_xero_adjustments_read_together'
     ) THEN
    RAISE EXCEPTION 'rollback left the V10 Xero adjustment columns behind';
  END IF;
END $$;
