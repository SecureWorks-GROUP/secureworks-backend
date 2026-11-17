-- Full CI has these objects already. The isolated case bootstraps only the
-- shadow-cost prerequisites, from the same historical migrations as CI.
SELECT to_regclass('public.job_cost_lines') IS NULL AS isolated_cost_setup \gset
\if :isolated_cost_setup
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE TABLE public.jobs(id uuid PRIMARY KEY, org_id uuid, job_number text, type text, status text);
CREATE TABLE public.feature_flags(flag_name text PRIMARY KEY, enabled boolean, description text);
-- These row types are needed to define the uncalled sync functions.
CREATE TABLE public.trade_invoices(id uuid PRIMARY KEY);
CREATE TABLE public.xero_supplier_credit_notes(credit_note_id text PRIMARY KEY);
\ir ../../../migrations/20261117160400_job_cost_lines.sql
\ir ../../../migrations/20261117171501_job_cost_lines_writer.sql
\ir ../../../migrations/20261117173001_job_cost_lines_followup8.sql
\endif
-- Keep the exact pre-migration function for a behavioural comparison.
CREATE SCHEMA IF NOT EXISTS fu11_proof;
DO $$ BEGIN
  EXECUTE replace(pg_get_functiondef('public.job_cost_lines_refollow(text,text)'::regprocedure),
    'public.job_cost_lines_refollow(', 'fu11_proof.previous_refollow(');
END $$;
