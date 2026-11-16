-- Prerequisites for 20261116080000_context_job_evidence_for_bills: the columns it reads, on the
-- tables the earlier registered setups and migrations already create (types as in production).
ALTER TABLE public.xero_invoices
 ADD COLUMN IF NOT EXISTS xero_invoice_id text, ADD COLUMN IF NOT EXISTS invoice_number text,
 ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS xero_contact_id text,
 ADD COLUMN IF NOT EXISTS contact_name text, ADD COLUMN IF NOT EXISTS invoice_date date,
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS reference text,
 ADD COLUMN IF NOT EXISTS line_items jsonb, ADD COLUMN IF NOT EXISTS invoice_type text,
 ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE public.suppliers
 ADD COLUMN IF NOT EXISTS name text, ADD COLUMN IF NOT EXISTS email text, ADD COLUMN IF NOT EXISTS xero_contact_id text;
ALTER TABLE public.purchase_orders
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS po_number text, ADD COLUMN IF NOT EXISTS supplier_id uuid,
 ADD COLUMN IF NOT EXISTS xero_contact_id text, ADD COLUMN IF NOT EXISTS supplier_name text,
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.dispatch_v2_supplier_order_refs
 ADD COLUMN IF NOT EXISTS ref text, ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE public.job_material_suppliers
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS supplier_id uuid, ADD COLUMN IF NOT EXISTS supplier_name text;
ALTER TABLE public.jobs
 ADD COLUMN IF NOT EXISTS job_number text, ADD COLUMN IF NOT EXISTS site_address text,
 ADD COLUMN IF NOT EXISTS site_suburb text, ADD COLUMN IF NOT EXISTS metadata jsonb;
