-- Minimal xero_invoices surface before the reconcile-attempt columns.

CREATE TABLE IF NOT EXISTS public.xero_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  xero_invoice_id text,
  invoice_type text,
  status text,
  amount_due numeric,
  amount_paid numeric,
  due_date date,
  line_items jsonb,
  raw_json jsonb,
  updated_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Contracts share one database in the ordered phase. An earlier contract
-- (20260911061500 deposit stamp) may already have created a narrower
-- xero_invoices, in which case CREATE TABLE IF NOT EXISTS above is a no-op.
-- Add every column this case relies on so both orders hold.
ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS xero_invoice_id text,
  ADD COLUMN IF NOT EXISTS invoice_type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS amount_due numeric,
  ADD COLUMN IF NOT EXISTS amount_paid numeric,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS line_items jsonb,
  ADD COLUMN IF NOT EXISTS raw_json jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
