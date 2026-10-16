-- After the down migration the reconcile columns are gone and the invoice
-- record table, with its seal, is untouched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'work_order_customer_variation_invoices'
      AND column_name IN ('reconciled_outcome', 'reconciled_by', 'reconciled_via', 'reconciled_at', 'reconcile_note')
  ) THEN
    RAISE EXCEPTION 'rollback: the reconcile columns must be removed';
  END IF;
  IF to_regclass('public.work_order_customer_variation_invoices') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_work_order_customer_variation_invoices_guard') THEN
    RAISE EXCEPTION 'rollback: the customer variation invoice record and its seal must remain';
  END IF;
END $$;
