-- Prerequisites for 20261102203000_dispatch_v2_scope_fill_revision (T20).
-- Only what the migration touches: dispatch_v2_scope_fills (to add the column
-- to) and scope_revisions (the table it references). Every statement is
-- idempotent, so this file is compatible with every earlier registered setup,
-- which may already have created jobs or scope_revisions with more columns.

CREATE TABLE IF NOT EXISTS public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

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

-- As 20261026120000_dispatch_v2_scope_fills.sql made it.
CREATE TABLE IF NOT EXISTS public.dispatch_v2_scope_fills (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  auto boolean NOT NULL,
  lines_added integer NOT NULL,
  supplier_id uuid NULL,
  scope_supplier text NULL,
  filled_at timestamptz NOT NULL DEFAULT now(),
  filled_by uuid NULL,
  filled_by_email text NULL,
  CONSTRAINT dispatch_v2_scope_fills_lines_added_valid CHECK (lines_added >= 0)
);
