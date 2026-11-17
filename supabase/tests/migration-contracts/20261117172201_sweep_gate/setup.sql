-- These are only the projected columns the token readers use.
CREATE TABLE IF NOT EXISTS public.xero_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS invoice_type text, ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS xero_invoice_id text;
CREATE TABLE IF NOT EXISTS public.trade_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_invoices ADD COLUMN IF NOT EXISTS xero_bill_id text;
CREATE TABLE IF NOT EXISTS public.purchase_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS po_number text,
  ADD COLUMN IF NOT EXISTS xero_contact_id text, ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS subtotal numeric, ADD COLUMN IF NOT EXISTS total numeric,
  ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS xero_bill_id text,
  ADD COLUMN IF NOT EXISTS delivery_date date;
CREATE TABLE IF NOT EXISTS public.context_email_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
