-- Pre-migration surface for the debt desk chase log: payment_chase_logs as
-- 20260326000001_clear_debt.sql created it, with the method CHECK as
-- 20260911120000_debt_picture.sql last defined it (nine values), and the
-- table grants Supabase gives every public table. No row-level security yet.
-- The jobs foreign key is left out: no earlier case needs this table, and the
-- contract is about the chase log's own shape and access.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.payment_chase_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  xero_invoice_id text,
  job_id uuid,
  ghl_contact_id text,
  contact_name text,
  method text NOT NULL,
  outcome text,
  notes text,
  follow_up_date date,
  follow_up_resolved boolean DEFAULT false,
  chased_by text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.payment_chase_logs DROP CONSTRAINT IF EXISTS payment_chase_logs_method_check;
ALTER TABLE public.payment_chase_logs ADD CONSTRAINT payment_chase_logs_method_check
  CHECK (method IN ('call','sms','auto_sms','email','note','status_change','personality_note','classification','proposal'));

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON public.payment_chase_logs TO anon, authenticated, service_role;
