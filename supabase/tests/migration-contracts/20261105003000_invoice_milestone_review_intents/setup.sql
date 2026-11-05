DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.jobs (id uuid PRIMARY KEY, org_id uuid NOT NULL, type text NOT NULL, status text NOT NULL, job_number text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS public.job_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE IF NOT EXISTS public.quote_revisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, job_document_id uuid, sent_at timestamptz, version integer, totals_snapshot_json jsonb, released_via text);
CREATE TABLE IF NOT EXISTS public.council_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, steps jsonb DEFAULT '[]',
  current_step_index integer DEFAULT 0
);
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS type text, ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.job_documents ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS type text, ADD COLUMN IF NOT EXISTS job_contact_id uuid,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz, ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz, ADD COLUMN IF NOT EXISTS quote_revision_id uuid;

CREATE TABLE IF NOT EXISTS public.job_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid);
ALTER TABLE public.job_assignments ADD COLUMN IF NOT EXISTS scheduled_date date,
  ADD COLUMN IF NOT EXISTS role text, ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS is_ghost boolean, ADD COLUMN IF NOT EXISTS assignment_type text;
