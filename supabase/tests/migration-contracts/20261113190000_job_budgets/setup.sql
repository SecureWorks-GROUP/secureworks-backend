-- Pre-migration surface for the job budget. Earlier registered cases already prepare
-- public.jobs, public.scope_revisions and public.job_events; this case adds only the
-- roles and the columns it reads (all idempotent).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
ALTER TABLE public.scope_revisions ADD COLUMN IF NOT EXISTS scope_canonical_text text;
ALTER TABLE public.scope_revisions ADD COLUMN IF NOT EXISTS pricing_canonical_text text;
ALTER TABLE public.scope_revisions ADD COLUMN IF NOT EXISTS scope_hash text;
ALTER TABLE public.scope_revisions ADD COLUMN IF NOT EXISTS pricing_hash text;
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS detail_json jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
