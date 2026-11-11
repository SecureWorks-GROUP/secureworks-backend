-- Pre-migration surface for the trade invoice money controls. Earlier cases
-- create trade_invoices and trade_invoice_lines; everything here is
-- IF NOT EXISTS so it stacks on them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.trade_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS week_start date,
  ADD COLUMN IF NOT EXISTS invoice_number text;

CREATE TABLE IF NOT EXISTS public.trade_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_invoice_id uuid
);
ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS line_type text,
  ADD COLUMN IF NOT EXISTS line_total_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS source_work_order_id uuid,
  ADD COLUMN IF NOT EXISTS group_share_id uuid;
