-- Prerequisites for 20261029123500_quote_revisions_scope_revision_link (JP-24 slice 1).
-- Only what the migration touches: quote_revisions (to add the column to) and
-- scope_revisions (the table it references). Every statement is idempotent so
-- this file is compatible with every earlier registered setup, which may
-- already have created quote_revisions and jobs with more columns.

CREATE TABLE IF NOT EXISTS public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

CREATE TABLE IF NOT EXISTS public.quote_revisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.quote_revisions
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS version integer;

-- The production shape of the columns the link and the contract read
-- (20260504090757_scope_revisions_and_artifacts.sql).
CREATE TABLE IF NOT EXISTS public.scope_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  revision_number int NOT NULL CHECK (revision_number >= 1),
  scope_hash text NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  pricing_hash text NOT NULL CHECK (pricing_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','frozen','superseded')),
  UNIQUE (job_id, revision_number)
);
