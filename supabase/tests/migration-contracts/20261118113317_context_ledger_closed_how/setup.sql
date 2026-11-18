-- Minimal standalone prerequisites; IF NOT EXISTS preserves the registered stack.
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $roles$;

CREATE TABLE IF NOT EXISTS public.organisations (
  id uuid PRIMARY KEY,
  name text
);
INSERT INTO public.organisations (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'ZZTEST')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY,
  org_id uuid,
  type text,
  status text,
  job_number text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.context_extraction_runs (
  id uuid PRIMARY KEY
);

SELECT to_regclass('public.context_ledger_items') IS NULL AS closed_how_needs_model \gset
\if :closed_how_needs_model
\ir ../../../migrations/20261006010000_context_ledger_model.sql
\endif
