-- Standalone B3 fixture for the disposable-database lane. Production column types,
-- synthetic rows only. B1 + B2 (20260911170000, 20260911170001, 20260911171000,
-- 20260914110000) are applied on top before the B3 migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE public.jobs(id uuid PRIMARY KEY,org_id uuid NOT NULL,status text NOT NULL,type text NOT NULL,job_number text NOT NULL UNIQUE,ghl_contact_id text,client_email text,client_phone text,site_suburb text,quoted_at timestamptz,metadata jsonb NOT NULL DEFAULT '{}',updated_at timestamptz DEFAULT now());
CREATE TABLE public.business_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid REFERENCES public.jobs(id),payload jsonb DEFAULT '{}',metadata jsonb DEFAULT '{}',body_preview text,contact_id text,match_status text,match_method text,match_confidence numeric,direction text,occurred_at timestamptz DEFAULT now());
CREATE TABLE public.contact_matches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,ghl_contact_id text,xero_contact_id text);
CREATE TABLE public.xero_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,invoice_number text);
CREATE TABLE public.purchase_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,po_number text);
CREATE TABLE public.inbox_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,metadata jsonb NOT NULL DEFAULT '{}',ghl_contact_id text,body_preview text,received_at timestamptz DEFAULT now());
CREATE TABLE public.job_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,event_type text,detail_json jsonb NOT NULL DEFAULT '{}',created_at timestamptz DEFAULT now());
CREATE TABLE public.job_context(id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES public.jobs(id),kind text NOT NULL,value jsonb NOT NULL,provenance jsonb NOT NULL,correlation_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.job_temporary_context(id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES public.jobs(id),kind text NOT NULL CHECK (kind IN ('current_state','pending_action','quote_issue')),value jsonb NOT NULL,provenance jsonb NOT NULL,correlation_id uuid,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.job_context, public.job_temporary_context TO service_role;
ALTER TABLE public.business_events ADD CONSTRAINT b2_fixture_match_status CHECK (match_status IN ('matched','ambiguous','unresolved','ignored') OR match_status IS NULL);
