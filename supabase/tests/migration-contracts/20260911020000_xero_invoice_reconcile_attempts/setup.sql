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
