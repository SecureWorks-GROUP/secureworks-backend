-- Xero evidence (20261005230000). The context tables, the ladder, the insert
-- trigger, capture_business_event, the catch-up list and jobs come from earlier
-- registered cases; xero_invoices comes from the deposit-stamp and reconcile
-- cases. Add every invoice column this case reads so any order holds.
ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS total numeric(12,2),
  ADD COLUMN IF NOT EXISTS amount_due numeric(12,2),
  ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2),
  ADD COLUMN IF NOT EXISTS invoice_date date,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS fully_paid_on date,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;
