-- Pre-migration surface for the bill pre-match: the facts table and the Bills to
-- place queue with their 20260705000010 checks. Earlier setups may already have made
-- jobs, purchase_orders and job_materials_facts, so everything is created only when
-- missing and columns are added only when missing.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS job_number text;

CREATE TABLE IF NOT EXISTS public.job_materials_facts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_materials_facts
  ADD COLUMN IF NOT EXISTS xero_invoice_id text,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS amount_ex_gst numeric,
  ADD COLUMN IF NOT EXISTS confidence text,
  ADD COLUMN IF NOT EXISTS automation_source text,
  ADD COLUMN IF NOT EXISTS match_reason text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_materials_facts_source_chk') THEN
    ALTER TABLE public.job_materials_facts ADD CONSTRAINT job_materials_facts_source_chk
      CHECK (automation_source IN ('xero_ref_link', 'po_deterministic', 'manual_queue'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.materials_reconciliation_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  xero_invoice_id text NOT NULL,
  invoice_number text,
  sub_total numeric,
  suggested_job_id uuid,
  suggestion_confidence text,
  status text NOT NULL DEFAULT 'open',
  assigned_job_id uuid,
  assigned_by text,
  assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT materials_recon_status_chk CHECK (status IN ('open', 'assigned', 'not_job_related'))
);
