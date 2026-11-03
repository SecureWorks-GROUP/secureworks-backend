-- C1 capture lanes read four record tables. Production has these columns; the
-- registered stack may not, so add only what the new reads use.
CREATE TABLE IF NOT EXISTS public.xero_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_type text NOT NULL);
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS invoice_type text;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS public.xero_settlement_evidence (provider_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), captured_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS public.job_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL);
ALTER TABLE public.job_documents ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE public.job_documents ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS public.job_media (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_media ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS public.job_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_assignments ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.job_assignments ADD COLUMN IF NOT EXISTS is_ghost boolean DEFAULT false;
