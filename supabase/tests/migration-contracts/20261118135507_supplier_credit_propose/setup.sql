-- CI stack already supplies these relations and migrations. Isolated single-case
-- runs build P2-03.1/P2-03.2 and P3-02.1 from their own migrations plus minimal
-- table shapes. No function stand-ins.
SELECT to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL AS p3023_need_reconcile_raise \gset
\if :p3023_need_reconcile_raise
\ir ../20261118073218_reconcile_item_raise/setup.sql
\ir ../../../migrations/20261118073218_reconcile_item_raise.sql
\endif

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role BYPASSRLS;
  ELSE
    ALTER ROLE service_role BYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.feature_flags (
  flag_name text PRIMARY KEY,
  enabled boolean NOT NULL,
  description text
);

CREATE TABLE IF NOT EXISTS public.organisations (
  id uuid PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY,
  org_id uuid,
  job_number text
);

CREATE TABLE IF NOT EXISTS public.context_email_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_message_id text NOT NULL,
  attachment_key text NOT NULL,
  business_event_id uuid,
  file_name text,
  content_type text,
  size_bytes bigint,
  sha256 text,
  storage_bucket text,
  storage_path text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.xero_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  xero_invoice_id text NOT NULL,
  xero_contact_id text,
  contact_name text,
  invoice_number text,
  invoice_type text NOT NULL,
  status text,
  job_id uuid,
  UNIQUE (org_id, xero_invoice_id)
);

CREATE TABLE IF NOT EXISTS public.xero_supplier_credit_notes (
  org_id uuid NOT NULL,
  xero_credit_note_id text NOT NULL,
  credit_note_type text NOT NULL DEFAULT 'ACCPAYCREDIT',
  credit_note_number text,
  xero_contact_id text,
  contact_name text,
  allocations_returned boolean NOT NULL DEFAULT false,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (org_id, xero_credit_note_id)
);
CREATE INDEX IF NOT EXISTS xero_supplier_credit_notes_contact_idx
  ON public.xero_supplier_credit_notes (org_id, xero_contact_id);

SELECT to_regclass('public.supplier_credit_drafts') IS NULL AS p3023_need_credit_drafts \gset
\if :p3023_need_credit_drafts
\ir ../../../migrations/20261118114119_supplier_credit_drafts.sql
\endif
