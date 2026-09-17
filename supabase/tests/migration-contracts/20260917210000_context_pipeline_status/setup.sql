-- Coverage reads xero_invoices.invoice_type (the live column). Earlier
-- registered fixtures already create the table; add only columns this
-- heartbeat needs if a narrower fixture won the CREATE TABLE race.
ALTER TABLE public.xero_invoices
 ADD COLUMN IF NOT EXISTS job_id uuid,
 ADD COLUMN IF NOT EXISTS invoice_type text,
 ADD COLUMN IF NOT EXISTS status text,
 ADD COLUMN IF NOT EXISTS amount_due numeric;
