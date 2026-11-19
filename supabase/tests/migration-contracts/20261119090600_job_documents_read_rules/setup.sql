-- Pre-migration state for 20261119090600_job_documents_read_rules: the 2025
-- rules on public.job_documents as 20250301000001_schema.sql wrote them, row
-- level security on, the API roles holding every table privilege (Supabase's
-- default privileges), and the 2025 helper auth_org_id().
-- public.jobs, public.users and public.job_documents already exist from
-- earlier registered cases.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
ALTER ROLE service_role BYPASSRLS;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
  ), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS site_suburb text;

ALTER TABLE public.job_documents
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS pdf_url text,
  ADD COLUMN IF NOT EXISTS data_snapshot_json jsonb,
  ADD COLUMN IF NOT EXISTS sent_to_client boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS share_token text;

-- The 2025 helper (20250301000001_schema.sql), which the 2025 rules and the
-- down migration name.
CREATE OR REPLACE FUNCTION public.auth_org_id()
RETURNS uuid AS $$
  SELECT org_id FROM public.users WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

ALTER TABLE public.job_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view job docs" ON public.job_documents;
DROP POLICY IF EXISTS "Estimators+ can create docs" ON public.job_documents;
DROP POLICY IF EXISTS "Estimators+ can update docs" ON public.job_documents;
DROP POLICY IF EXISTS "Public can view shared docs" ON public.job_documents;
CREATE POLICY "Users can view job docs"
  ON public.job_documents FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.jobs WHERE jobs.id = job_documents.job_id AND jobs.org_id = public.auth_org_id()));
CREATE POLICY "Estimators+ can create docs"
  ON public.job_documents FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.jobs WHERE jobs.id = job_documents.job_id AND jobs.org_id = public.auth_org_id()));
CREATE POLICY "Estimators+ can update docs"
  ON public.job_documents FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.jobs WHERE jobs.id = job_documents.job_id AND jobs.org_id = public.auth_org_id()));
CREATE POLICY "Public can view shared docs"
  ON public.job_documents FOR SELECT
  USING (share_token IS NOT NULL AND sent_to_client = true);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON public.job_documents TO anon, authenticated, service_role;
