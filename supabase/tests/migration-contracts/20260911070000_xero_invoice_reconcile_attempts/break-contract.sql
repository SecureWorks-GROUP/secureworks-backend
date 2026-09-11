-- Remove the promised ordering column so contract.sql must fail.
ALTER TABLE public.xero_invoices DROP COLUMN IF EXISTS reconcile_attempted_at;
