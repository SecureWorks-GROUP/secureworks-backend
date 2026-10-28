-- Prerequisites for 20261028031500_scope_job_mint_patio.
-- The fencing mint (20260721000001 and its record guards 20260723000001) is
-- not a registered case, so its live schema is stood up here from the two
-- repository files, over only the columns the mint reads and writes. Every
-- statement is idempotent so this stays compatible with earlier setups.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.organisations (id uuid PRIMARY KEY);
ALTER TABLE public.organisations ADD COLUMN IF NOT EXISTS name text;

CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS org_id uuid;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS name text;

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  status text NOT NULL,
  type text NOT NULL,
  job_number text NOT NULL UNIQUE
);
ALTER TABLE public.jobs ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS client_phone text,
  ADD COLUMN IF NOT EXISTS client_email text,
  ADD COLUMN IF NOT EXISTS site_address text,
  ADD COLUMN IF NOT EXISTS site_suburb text,
  ADD COLUMN IF NOT EXISTS ghl_contact_id text,
  ADD COLUMN IF NOT EXISTS ghl_opportunity_id text,
  ADD COLUMN IF NOT EXISTS scope_json jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.job_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_events
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS detail_json jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- The registered repair case owns the live next_job_number. Stand in a
-- minimal one only when no earlier case created it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'next_job_number'
  ) THEN
    CREATE SEQUENCE IF NOT EXISTS public.scope_mint_contract_seq START 1001;
    EXECUTE $f$
      CREATE FUNCTION public.next_job_number(job_type text DEFAULT 'patio') RETURNS text
      LANGUAGE sql AS $b$
        SELECT CASE job_type WHEN 'fencing' THEN 'SWF-' WHEN 'patio' THEN 'SWP-' ELSE 'SW-' END
          || '26' || nextval('public.scope_mint_contract_seq')::text
      $b$
    $f$;
  END IF;
END $$;

\ir ../../../migrations/20260721000001_fence_job_mint.sql
\ir ../../../migrations/20260723000001_fence_job_mint_record_guards.sql
