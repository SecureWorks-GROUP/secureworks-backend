-- Pre-migration surface for job commissions. Earlier registered cases already
-- create public.jobs, public.users, public.trade_invoices,
-- public.trade_invoice_lines and (20261113190000) public.job_budgets; this case
-- adds only the roles, auth.uid() and the columns it reads (all idempotent).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS org_id uuid;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE public.trade_invoices ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.trade_invoices ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.trade_invoice_lines ADD COLUMN IF NOT EXISTS trade_invoice_id uuid;
ALTER TABLE public.trade_invoice_lines ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE public.trade_invoice_lines ADD COLUMN IF NOT EXISTS line_type text;
ALTER TABLE public.trade_invoice_lines ADD COLUMN IF NOT EXISTS line_total_ex numeric(12,2);
ALTER TABLE public.trade_invoice_lines ADD COLUMN IF NOT EXISTS office_review_status text;
