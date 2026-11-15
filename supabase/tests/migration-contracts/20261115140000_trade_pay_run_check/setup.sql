-- Prerequisites for 20261115140000_trade_pay_run_check. Creates only what the check reads and
-- what earlier registered cases may not have made. Every statement is IF NOT EXISTS, so it sits
-- on top of whatever the registered stack already holds.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS name text;

CREATE TABLE IF NOT EXISTS public.trade_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS week_start date,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS invoice_source text,
  ADD COLUMN IF NOT EXISTS gst_on boolean,
  ADD COLUMN IF NOT EXISTS gst numeric,
  ADD COLUMN IF NOT EXISTS net_pay numeric,
  ADD COLUMN IF NOT EXISTS recurring_deduction_amount numeric,
  ADD COLUMN IF NOT EXISTS xero_adjustments_ex numeric,
  ADD COLUMN IF NOT EXISTS xero_bill_id text,
  ADD COLUMN IF NOT EXISTS xero_bill_status text,
  ADD COLUMN IF NOT EXISTS xero_bill_total numeric;

CREATE TABLE IF NOT EXISTS public.trade_invoice_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS trade_invoice_id uuid,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS job_number text,
  ADD COLUMN IF NOT EXISTS line_type text,
  ADD COLUMN IF NOT EXISTS line_total_ex numeric,
  ADD COLUMN IF NOT EXISTS hourly_rate numeric,
  ADD COLUMN IF NOT EXISTS total_hours numeric,
  ADD COLUMN IF NOT EXISTS baseline_hours numeric,
  ADD COLUMN IF NOT EXISTS flag_type text,
  ADD COLUMN IF NOT EXISTS work_date date,
  ADD COLUMN IF NOT EXISTS line_date date,
  ADD COLUMN IF NOT EXISTS job_work_order_id uuid;

CREATE TABLE IF NOT EXISTS public.work_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS agreed_labour_ex numeric;

CREATE TABLE IF NOT EXISTS public.trade_rates (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_rates
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS hourly_rate numeric,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to date;

CREATE TABLE IF NOT EXISTS public.job_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS scheduled_date date,
  ADD COLUMN IF NOT EXISTS scheduled_end date,
  ADD COLUMN IF NOT EXISTS hourly_rate numeric;
