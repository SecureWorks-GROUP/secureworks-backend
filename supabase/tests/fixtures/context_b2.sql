-- Standalone B2 fixture. UUID identities match production, no client records.
CREATE TABLE public.jobs(id uuid PRIMARY KEY,org_id uuid NOT NULL,status text NOT NULL,type text NOT NULL,job_number text NOT NULL UNIQUE,ghl_contact_id text,client_email text,client_phone text,site_suburb text,updated_at timestamptz DEFAULT now());
CREATE TABLE public.business_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid REFERENCES public.jobs(id),payload jsonb DEFAULT '{}',body_preview text,contact_id text,match_status text,match_method text,match_confidence numeric,direction text,occurred_at timestamptz DEFAULT now());
CREATE TABLE public.contact_matches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,ghl_contact_id text,xero_contact_id text);
CREATE TABLE public.xero_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,invoice_number text);
CREATE TABLE public.purchase_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,po_number text);

-- The checked-in T7 envelope constraint; live readback unavailable (HTTP401).
ALTER TABLE public.business_events ADD CONSTRAINT b2_fixture_match_status CHECK (match_status IN ('matched','ambiguous','unresolved','ignored') OR match_status IS NULL);
