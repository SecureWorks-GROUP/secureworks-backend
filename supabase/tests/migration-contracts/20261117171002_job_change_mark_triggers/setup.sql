-- Earlier registered setups supply all 14 record tables and the organisation.
-- The invoice housekeeping column is needed by this contract.
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS updated_at timestamptz;
