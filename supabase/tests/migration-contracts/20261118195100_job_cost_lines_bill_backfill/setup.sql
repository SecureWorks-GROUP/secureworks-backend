-- The live xero_invoices and trade_invoices columns the bills backfill twin reads
-- (20250301000003 reporting schema and later; not all earlier cases add them).
ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS xero_invoice_id text,
  ADD COLUMN IF NOT EXISTS invoice_type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS invoice_date date,
  ADD COLUMN IF NOT EXISTS xero_contact_id text,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS fully_paid_on date,
  ADD COLUMN IF NOT EXISTS line_items jsonb,
  ADD COLUMN IF NOT EXISTS sub_total numeric(12,2),
  ADD COLUMN IF NOT EXISTS raw_json jsonb;
ALTER TABLE public.trade_invoices ADD COLUMN IF NOT EXISTS xero_bill_id text;
