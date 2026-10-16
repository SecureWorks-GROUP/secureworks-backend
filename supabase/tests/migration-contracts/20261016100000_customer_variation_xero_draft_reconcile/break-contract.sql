-- Remove the rule that an answer names who gave it, how and when.
ALTER TABLE public.work_order_customer_variation_invoices
  DROP CONSTRAINT IF EXISTS work_order_customer_variation_invoices_reconcile_check;
