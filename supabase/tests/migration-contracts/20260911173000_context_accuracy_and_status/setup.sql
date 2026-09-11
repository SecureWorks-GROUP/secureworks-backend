-- Columns consumed by existing invoice_context reads; preserve production scalar types.
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS type text,
 ADD COLUMN IF NOT EXISTS status text,ADD COLUMN IF NOT EXISTS amount_due numeric;
