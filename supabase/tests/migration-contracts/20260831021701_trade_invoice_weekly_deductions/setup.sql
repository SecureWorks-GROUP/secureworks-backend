-- Minimal pre-migration surface for weekly work-order invoice deductions.
-- Earlier registered cases already own public.jobs and public.trade_invoices.

CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.work_orders (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  status text,
  scope_items jsonb,
  scheduled_date date,
  completed_at timestamptz,
  site_address text
);

CREATE TABLE IF NOT EXISTS public.job_assignments (
  id uuid PRIMARY KEY,
  job_id uuid REFERENCES public.jobs(id),
  user_id uuid REFERENCES public.users(id),
  status text,
  invoiced_in uuid
);

CREATE TABLE IF NOT EXISTS public.trade_rates (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id),
  hourly_rate numeric(8,2) NOT NULL,
  effective_from date NOT NULL,
  effective_to date
);

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS week_start date,
  ADD COLUMN IF NOT EXISTS week_end date,
  ADD COLUMN IF NOT EXISTS total_hours numeric(10,2),
  ADD COLUMN IF NOT EXISTS total_breaks_minutes integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invoice_source text DEFAULT 'hourly',
  ADD COLUMN IF NOT EXISTS work_order_id uuid,
  ADD COLUMN IF NOT EXISTS has_manual_overrides boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_details jsonb,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS xero_bill_id text,
  ADD COLUMN IF NOT EXISTS xero_pushed_at timestamptz;

CREATE TABLE IF NOT EXISTS public.trade_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_invoice_id uuid NOT NULL REFERENCES public.trade_invoices(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.jobs(id),
  job_number text,
  client_name text,
  total_hours numeric(10,2),
  hourly_rate numeric(10,2),
  line_total_ex numeric(12,2) NOT NULL,
  override_amount numeric(12,2),
  acknowledgment_status text DEFAULT 'pending',
  line_date date,
  division text,
  line_type text,
  description text,
  quantity numeric(10,2),
  unit text,
  unit_rate numeric(12,2),
  flag_type text,
  baseline_hours numeric(10,2),
  baseline_source text,
  hours_justification text,
  flagged_at timestamptz
);
