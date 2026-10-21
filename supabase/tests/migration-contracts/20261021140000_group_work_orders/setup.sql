-- Pre-migration surface for group work orders. Earlier cases already create
-- jobs, users, trade invoices and feature_flags. Everything here is
-- IF NOT EXISTS. Do not reset work_orders constraints: this setup runs
-- after the job work order migration has widened them.
-- group_share_id is added by the migration under test, not here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
  ), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

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
  ADD COLUMN IF NOT EXISTS job_number text;

CREATE TABLE IF NOT EXISTS public.trade_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS status text;

CREATE TABLE IF NOT EXISTS public.trade_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_invoice_id uuid
);
ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS line_type text;

CREATE TABLE IF NOT EXISTS public.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  description text,
  updated_at timestamptz DEFAULT now()
);
