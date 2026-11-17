-- The shared stack already supplies these relations. Minimal shapes also let
-- this one contract run alone in an owned disposable PostgreSQL database.
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $roles$;
CREATE TABLE IF NOT EXISTS public.jobs (id uuid PRIMARY KEY, org_id uuid, status text, type text, job_number text);
CREATE TABLE IF NOT EXISTS public.business_events (job_id uuid);
CREATE TABLE IF NOT EXISTS public.xero_invoices (job_id uuid, status text, amount_due numeric, invoice_type text);
CREATE TABLE IF NOT EXISTS public.context_ledger_generations (id uuid PRIMARY KEY, job_id uuid, kind text, status text, reader text, model text, evidence_until timestamptz, checks jsonb, created_at timestamptz, finished_at timestamptz, promoted_at timestamptz, updated_at timestamptz);
CREATE TABLE IF NOT EXISTS public.feature_flags (flag_name text PRIMARY KEY, enabled boolean, description text);
DO $view$ BEGIN
  IF to_regclass('public.current_job_context_facts') IS NULL THEN
    EXECUTE 'CREATE VIEW public.current_job_context_facts AS SELECT NULL::uuid AS job_id WHERE false';
  END IF;
END $view$;
-- Latest main coverage is not registered as a separate contract case.
\ir ../../../migrations/20261102200000_context_coverage_counts_ledger.sql
