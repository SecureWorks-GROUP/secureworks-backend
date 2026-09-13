-- Disposable database only. Core referenced production column types.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE public.jobs(id uuid PRIMARY KEY, org_id uuid NOT NULL, status text NOT NULL, type text NOT NULL, job_number text NOT NULL UNIQUE);
CREATE TABLE public.business_events(id uuid PRIMARY KEY,job_id uuid REFERENCES public.jobs(id));
