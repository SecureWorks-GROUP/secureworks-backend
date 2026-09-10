-- Minimal pre-migration surface for the SES report trigger contract.
-- Earlier registered cases may already have created jobs and job_events with a
-- narrower shape; add only the columns this contract writes, without changing
-- any column those cases rely on.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS job_number text;
CREATE TABLE IF NOT EXISTS public.job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS detail_json jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
CREATE OR REPLACE FUNCTION public.makesafe_cron_enabled() RETURNS boolean
  LANGUAGE sql AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text
  LANGUAGE sql AS $$ SELECT 'contract-fixture-key' $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
