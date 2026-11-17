-- Standalone-only schema and stand-ins; a full registered stack keeps its real objects.
SELECT to_regprocedure('public.context_client_story(uuid,timestamptz)') IS NULL AS p0013_standalone \gset
\if :p0013_standalone
DO $roles$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $roles$;
CREATE TABLE public.jobs(id uuid PRIMARY KEY,job_number text,type text,status text,created_at timestamptz,
 ghl_contact_id text,client_email text,xero_contact_id text,client_name text,org_id uuid,pricing_json jsonb);
CREATE TABLE public.job_contacts(id uuid PRIMARY KEY,job_id uuid,removed_at timestamptz,is_primary boolean,
 contact_type text,xero_contact_id text,client_name text,ghl_contact_id text,created_at timestamptz);
CREATE TABLE public.xero_invoices(id uuid PRIMARY KEY,job_id uuid,xero_contact_id text,contact_name text,
 invoice_type text,status text,created_at timestamptz,synced_at timestamptz,amount_due numeric,
 due_date date,invoice_date date,invoice_number text);
CREATE TABLE public.context_ledger_generations(id uuid PRIMARY KEY,job_id uuid,status text);
CREATE TABLE public.context_ledger_items(id uuid PRIMARY KEY,generation_id uuid,opened_by jsonb,
 item_type text,what text,status text,opened_at timestamptz,closed_at timestamptz,item_key text,about_key text);
CREATE TABLE public.business_events(id uuid PRIMARY KEY,job_id uuid,attribution_status text,metadata jsonb);
CREATE TABLE public.context_job_story_texts(id uuid DEFAULT gen_random_uuid(),job_id uuid,written_at timestamptz,
 checked_at timestamptz,sections jsonb,superseded_at timestamptz,status text,card_hash text,model text);
CREATE FUNCTION public.context_linked_status(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $s$ SELECT $1='linked' $s$;
CREATE FUNCTION public.context_job_record_money(uuid[],timestamptz) RETURNS TABLE(job_id uuid,party text,
 invoices jsonb,not_yet_invoiced numeric,xero_contact_id text,owing numeric,overdue numeric)
 LANGUAGE sql STABLE AS $s$ SELECT unnest($1),NULL::text,'[]'::jsonb,0::numeric,NULL::text,0::numeric,0::numeric $s$;
-- Signature-compatible stand-ins for functions supplied by main's much wider story stack.
CREATE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL,p_since timestamptz DEFAULT NULL,p_record_only boolean DEFAULT false)
 RETURNS jsonb LANGUAGE sql AS $s$ SELECT '{}'::jsonb $s$;
CREATE FUNCTION public.context_job_story_text_get(uuid,jsonb,boolean) RETURNS jsonb LANGUAGE sql AS $s$ SELECT '{}'::jsonb $s$;
CREATE TABLE public.feature_flags(flag_name text PRIMARY KEY,enabled boolean);
CREATE TABLE public.job_change_marks(job_id uuid PRIMARY KEY,last_marked_at timestamptz,mark_version bigint);
CREATE TABLE public.job_page_marks_seen(job_id uuid PRIMARY KEY,mark_version bigint,page_done_at timestamptz,story_done_at timestamptz);
-- Real P0-01.1 storage and refresh for the isolated contract, not a fake page builder.
\ir ../../../migrations/20261117171304_job_pages.sql
\ir ../../../rollbacks/20261118041726_context_client_story_stored_down.sql
REVOKE ALL ON FUNCTION public.context_client_story(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_client_story(uuid,timestamptz) TO service_role;
\endif
