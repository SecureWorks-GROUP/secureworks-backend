-- Roll back 20261016100000_customer_variation_xero_draft_reconcile.
--
-- Drops the reconcile columns. Refuses while any record carries an answer, so
-- it never silently loses who released or recorded a variation's Xero draft:
-- the job_events rows keep the history, but the row's own record goes first by
-- a human's decision.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'work_order_customer_variation_invoices'
      AND column_name = 'reconciled_outcome'
  ) AND EXISTS (
    SELECT 1 FROM public.work_order_customer_variation_invoices
    WHERE reconciled_outcome IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'customer variation Xero draft records carry a reconcile answer: resolve them before rolling back 20261016100000_customer_variation_xero_draft_reconcile';
  END IF;
END $$;

ALTER TABLE public.work_order_customer_variation_invoices
  DROP CONSTRAINT IF EXISTS work_order_customer_variation_invoices_reconcile_check;
ALTER TABLE public.work_order_customer_variation_invoices
  DROP COLUMN IF EXISTS reconcile_note,
  DROP COLUMN IF EXISTS reconciled_at,
  DROP COLUMN IF EXISTS reconciled_via,
  DROP COLUMN IF EXISTS reconciled_by,
  DROP COLUMN IF EXISTS reconciled_outcome;
