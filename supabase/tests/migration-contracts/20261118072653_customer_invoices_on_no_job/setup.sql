-- The registered walk already supplies these relations and roles. Its current
-- evidence relation is a fixture table with the same placement columns.
SELECT to_regclass('public.xero_invoices') IS NULL AS standalone \gset
\if :standalone
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.organisations(id uuid PRIMARY KEY, name text);
CREATE TABLE public.jobs(id uuid PRIMARY KEY, org_id uuid, job_number text, status text, type text);
CREATE TABLE public.xero_invoices(
  org_id uuid NOT NULL REFERENCES public.organisations, xero_invoice_id text NOT NULL,
  job_id uuid REFERENCES public.jobs, invoice_number text, invoice_type text, contact_name text,
  invoice_date date, status text, total numeric, line_items jsonb, UNIQUE(org_id, xero_invoice_id)
);
CREATE INDEX idx_xero_invoices_unlinked ON public.xero_invoices(job_id) WHERE job_id IS NULL;
CREATE INDEX idx_xero_invoices_date ON public.xero_invoices(invoice_date);
CREATE TABLE public.feature_flags(flag_name text PRIMARY KEY, enabled boolean, description text);
\endif
