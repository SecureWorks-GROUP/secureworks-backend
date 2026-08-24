-- Minimal pre-migration schema surface required by this contract.
-- This is test infrastructure, not a replacement for the production schema.

CREATE TABLE public.jobs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  status text NOT NULL,
  type text NOT NULL,
  job_number text NOT NULL UNIQUE
);

CREATE TABLE public.job_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  type text NOT NULL,
  file_name text,
  storage_url text,
  version integer NOT NULL DEFAULT 1,
  superseded_at timestamptz
);
