-- Prerequisites for 20261104010000_dispatch_order_bill_links: only the tables and columns its two views read,
-- added without changing anything an earlier registered case created.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  status text NOT NULL,
  type text NOT NULL,
  job_number text NOT NULL UNIQUE
);
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  email text
);
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS xero_contact_id text;

CREATE TABLE IF NOT EXISTS public.xero_invoices (
  org_id uuid NOT NULL,
  xero_invoice_id text NOT NULL,
  invoice_type text NOT NULL
);
ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS xero_contact_id text,
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS line_items jsonb,
  ADD COLUMN IF NOT EXISTS sub_total numeric,
  ADD COLUMN IF NOT EXISTS invoice_date date,
  ADD COLUMN IF NOT EXISTS job_id uuid;

CREATE TABLE IF NOT EXISTS public.purchase_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS po_number text,
  ADD COLUMN IF NOT EXISTS supplier_name text,
  ADD COLUMN IF NOT EXISTS supplier_id uuid,
  ADD COLUMN IF NOT EXISTS xero_contact_id text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS subtotal numeric,
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Dispatch v2 (20261023214200, 20261023230000): only the columns the views read.
CREATE TABLE IF NOT EXISTS public.dispatch_supplier_order_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  supplier_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  subject text NOT NULL,
  sent_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.dispatch_v2_supplier_order_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  order_id uuid NOT NULL,
  job_id uuid NOT NULL,
  supplier_key text NULL,
  supplier_name text NULL,
  ref text NOT NULL,
  linked_via text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_v2_supplier_order_refs_unique UNIQUE (order_id, ref)
);

-- The placements a bill can already have (the contract proves none moves).
CREATE TABLE IF NOT EXISTS public.job_materials_facts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_materials_facts
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS xero_invoice_id text,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS amount_ex_gst numeric,
  ADD COLUMN IF NOT EXISTS assigned_by text;
CREATE TABLE IF NOT EXISTS public.materials_reconciliation_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  xero_invoice_id text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  assigned_job_id uuid,
  assigned_by text
);
