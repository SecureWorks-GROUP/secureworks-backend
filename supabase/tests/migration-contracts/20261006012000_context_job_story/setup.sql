-- Prerequisites for 20261006012000_context_job_story (same as the record case,
-- plus job_contacts): the live columns the
-- record functions read that earlier registered setups do not create. Every
-- statement is IF NOT EXISTS, so it is a no-op on a fuller schema and keeps the
-- case runnable after the earlier stack. Column names and types are the live
-- ones (information_schema, read-only, 5 Oct 2026).
DO $roles$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

CREATE TABLE IF NOT EXISTS public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.jobs
 ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS type text, ADD COLUMN IF NOT EXISTS job_number text,
 ADD COLUMN IF NOT EXISTS client_name text, ADD COLUMN IF NOT EXISTS client_email text, ADD COLUMN IF NOT EXISTS client_phone text,
 ADD COLUMN IF NOT EXISTS site_suburb text, ADD COLUMN IF NOT EXISTS ghl_contact_id text, ADD COLUMN IF NOT EXISTS pricing_json jsonb,
 ADD COLUMN IF NOT EXISTS scope_json jsonb, ADD COLUMN IF NOT EXISTS metadata jsonb,
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS quoted_at timestamptz,
 ADD COLUMN IF NOT EXISTS accepted_at timestamptz, ADD COLUMN IF NOT EXISTS approvals_at timestamptz,
 ADD COLUMN IF NOT EXISTS processing_at timestamptz, ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
 ADD COLUMN IF NOT EXISTS completed_at timestamptz, ADD COLUMN IF NOT EXISTS deposit_at timestamptz,
 ADD COLUMN IF NOT EXISTS deposit_amount numeric, ADD COLUMN IF NOT EXISTS deposit_invoice_id text,
 ADD COLUMN IF NOT EXISTS quoted_value numeric, ADD COLUMN IF NOT EXISTS callback_parent_id uuid,
 ADD COLUMN IF NOT EXISTS archived boolean;

CREATE TABLE IF NOT EXISTS public.business_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.business_events
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS event_type text, ADD COLUMN IF NOT EXISTS source text,
 ADD COLUMN IF NOT EXISTS channel text, ADD COLUMN IF NOT EXISTS direction text, ADD COLUMN IF NOT EXISTS contact_id text,
 ADD COLUMN IF NOT EXISTS payload jsonb DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
 ADD COLUMN IF NOT EXISTS body_preview text, ADD COLUMN IF NOT EXISTS occurred_at timestamptz DEFAULT now(),
 ADD COLUMN IF NOT EXISTS recorded_at timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS event_at timestamptz,
 ADD COLUMN IF NOT EXISTS attribution_status text, ADD COLUMN IF NOT EXISTS provider_message_id text,
 ADD COLUMN IF NOT EXISTS source_table text, ADD COLUMN IF NOT EXISTS source_id text;

CREATE TABLE IF NOT EXISTS public.inbox_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.inbox_events
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS from_email text, ADD COLUMN IF NOT EXISTS to_email text,
 ADD COLUMN IF NOT EXISTS subject text, ADD COLUMN IF NOT EXISTS body_preview text, ADD COLUMN IF NOT EXISTS received_at timestamptz,
 ADD COLUMN IF NOT EXISTS graph_message_id text, ADD COLUMN IF NOT EXISTS mailbox text, ADD COLUMN IF NOT EXISTS classification text;

CREATE TABLE IF NOT EXISTS public.xero_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.xero_invoices
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS xero_invoice_id text, ADD COLUMN IF NOT EXISTS xero_contact_id text,
 ADD COLUMN IF NOT EXISTS contact_name text, ADD COLUMN IF NOT EXISTS invoice_number text, ADD COLUMN IF NOT EXISTS invoice_type text,
 ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS reference text, ADD COLUMN IF NOT EXISTS total numeric,
 ADD COLUMN IF NOT EXISTS amount_due numeric, ADD COLUMN IF NOT EXISTS amount_paid numeric, ADD COLUMN IF NOT EXISTS invoice_date date,
 ADD COLUMN IF NOT EXISTS due_date date, ADD COLUMN IF NOT EXISTS fully_paid_on date, ADD COLUMN IF NOT EXISTS raw_json jsonb, ADD COLUMN IF NOT EXISTS synced_at timestamptz,
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.job_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_documents
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS type text, ADD COLUMN IF NOT EXISTS version integer,
 ADD COLUMN IF NOT EXISTS quote_number text, ADD COLUMN IF NOT EXISTS run_label text, ADD COLUMN IF NOT EXISTS job_contact_id uuid,
 ADD COLUMN IF NOT EXISTS file_name text, ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
 ADD COLUMN IF NOT EXISTS sent_at timestamptz, ADD COLUMN IF NOT EXISTS viewed_at timestamptz, ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
 ADD COLUMN IF NOT EXISTS declined_at timestamptz, ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

CREATE TABLE IF NOT EXISTS public.job_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_assignments
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS role text, ADD COLUMN IF NOT EXISTS scheduled_date date,
 ADD COLUMN IF NOT EXISTS scheduled_end date, ADD COLUMN IF NOT EXISTS start_time time, ADD COLUMN IF NOT EXISTS assignment_type text,
 ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS crew_name text, ADD COLUMN IF NOT EXISTS confirmation_status text,
 ADD COLUMN IF NOT EXISTS started_at timestamptz, ADD COLUMN IF NOT EXISTS completed_at timestamptz, ADD COLUMN IF NOT EXISTS is_ghost boolean DEFAULT false,
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS updated_at timestamptz;

CREATE TABLE IF NOT EXISTS public.job_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_events
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS event_type text, ADD COLUMN IF NOT EXISTS detail_json jsonb,
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.email_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.email_events
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS email_type text, ADD COLUMN IF NOT EXISTS recipient text,
 ADD COLUMN IF NOT EXISTS subject text, ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS sent_at timestamptz,
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.visit_outcomes (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.visit_outcomes
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS contact_id text, ADD COLUMN IF NOT EXISTS visit_start timestamptz,
 ADD COLUMN IF NOT EXISTS outcome text, ADD COLUMN IF NOT EXISTS reason text, ADD COLUMN IF NOT EXISTS quote_owed boolean,
 ADD COLUMN IF NOT EXISTS recorded_at timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS supersedes uuid;

CREATE TABLE IF NOT EXISTS public.job_variations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_variations
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS variation_number integer, ADD COLUMN IF NOT EXISTS description text,
 ADD COLUMN IF NOT EXISTS amount numeric, ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS sent_at timestamptz,
 ADD COLUMN IF NOT EXISTS accepted_at timestamptz, ADD COLUMN IF NOT EXISTS declined_at timestamptz,
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.purchase_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.purchase_orders
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS po_number text, ADD COLUMN IF NOT EXISTS supplier_name text,
 ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS total numeric, ADD COLUMN IF NOT EXISTS delivery_date date,
 ADD COLUMN IF NOT EXISTS confirmed_delivery_date date, ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.work_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.work_orders
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS wo_number text, ADD COLUMN IF NOT EXISTS status text,
 ADD COLUMN IF NOT EXISTS trade_name text, ADD COLUMN IF NOT EXISTS sent_at timestamptz, ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
 ADD COLUMN IF NOT EXISTS completed_at timestamptz, ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Helpers the record functions call. The registered stack creates the live
-- bodies; these stand-ins (identical bodies) only make the case runnable alone.
DO $helpers$
BEGIN
 IF to_regprocedure('public.context_event_text(public.business_events)') IS NULL THEN
  EXECUTE $f$CREATE FUNCTION public.context_event_text(e public.business_events) RETURNS text LANGUAGE sql IMMUTABLE
   SET search_path = public, pg_temp AS $b$ SELECT coalesce(nullif(e.payload->>'body',''), nullif(e.payload->>'message_text',''),
   nullif(e.payload->>'text',''),nullif(e.payload->>'note_text',''),nullif(e.payload->>'note',''),nullif(e.payload->>'transcript',''),e.body_preview,'') $b$$f$;
 END IF;
 IF to_regprocedure('public.context_internal_text_role(public.business_events)') IS NULL THEN
  EXECUTE $f$CREATE FUNCTION public.context_internal_text_role(e public.business_events) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
   SELECT CASE WHEN btrim(public.context_event_text(e)) ~ '^(New job assigned|Job ready for crew|New make-safe|New repair): ' THEN 'crew'
   WHEN btrim(public.context_event_text(e)) ~ '^(Docs Ready: |SecureWorks: New make-safe )' THEN 'staff' ELSE 'other' END $b$$f$;
 END IF;
END $helpers$;

CREATE TABLE IF NOT EXISTS public.job_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_contacts
 ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS client_name text, ADD COLUMN IF NOT EXISTS contact_type text,
 ADD COLUMN IF NOT EXISTS is_primary boolean, ADD COLUMN IF NOT EXISTS ghl_contact_id text, ADD COLUMN IF NOT EXISTS removed_at timestamptz,
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
