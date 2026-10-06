-- Pre-migration surface for the job work order layer. Earlier registered cases
-- already create public.jobs, public.users, public.work_orders,
-- public.trade_invoices, public.trade_invoice_lines and public.feature_flags in
-- reduced shapes, so every table here is IF NOT EXISTS and every column the
-- migration and its contract touch is added IF NOT EXISTS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY);
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS role text;

CREATE TABLE IF NOT EXISTS public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS job_number text,
  ADD COLUMN IF NOT EXISTS site_address text,
  ADD COLUMN IF NOT EXISTS site_suburb text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.work_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.work_orders ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS wo_number text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS assigned_user_id uuid,
  ADD COLUMN IF NOT EXISTS scope_items jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS special_instructions text,
  ADD COLUMN IF NOT EXISTS scheduled_date date,
  ADD COLUMN IF NOT EXISTS site_address text,
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
-- Live shape: job_id is nullable and ON DELETE SET NULL (an earlier reduced
-- setup declared it NOT NULL with no delete action). Earlier contracts delete
-- fencing jobs that the migration's trigger now gives a draft work order.
ALTER TABLE public.work_orders ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_job_id_fkey;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_job_id_fkey
  FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_status_check
  CHECK (status IN ('draft', 'sent', 'accepted', 'in_progress', 'complete', 'cancelled'));

CREATE TABLE IF NOT EXISTS public.trade_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS subtotal_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS gst numeric(12,2),
  ADD COLUMN IF NOT EXISTS total_inc numeric(12,2),
  ADD COLUMN IF NOT EXISTS gst_on boolean,
  ADD COLUMN IF NOT EXISTS super_rate numeric,
  ADD COLUMN IF NOT EXISTS super_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS gross_earned numeric(12,2),
  ADD COLUMN IF NOT EXISTS net_pay numeric(12,2);

CREATE TABLE IF NOT EXISTS public.trade_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_invoice_id uuid NOT NULL REFERENCES public.trade_invoices(id) ON DELETE CASCADE
);
ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS line_type text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS total_hours numeric(10,2),
  ADD COLUMN IF NOT EXISTS work_order_hours numeric(6,2),
  ADD COLUMN IF NOT EXISTS line_total_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS override_amount numeric(12,2);

CREATE TABLE IF NOT EXISTS public.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  description text,
  updated_at timestamptz DEFAULT now()
);
