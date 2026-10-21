-- Contract fixture for 20261021140000_job_profit_work_order_xero_bills.sql.
-- Only feature_flags is restated, in its live shape, in case no earlier case
-- made it. Test infrastructure, not a replacement for the production schema.
CREATE TABLE IF NOT EXISTS public.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  description text,
  updated_at timestamptz DEFAULT now()
);

-- The contract runner never applies 20260504090757, so the patio quote the
-- view reads does not exist until this case. Columns are the ones the view
-- and this contract write. Nullable where an earlier insert would not know
-- them; this file runs before the migration, and later contracts do not
-- write scope revisions.
CREATE TABLE IF NOT EXISTS public.scope_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
ALTER TABLE public.scope_revisions
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS revision_number int,
  ADD COLUMN IF NOT EXISTS tool_kind text,
  ADD COLUMN IF NOT EXISTS scope_canonical_text text,
  ADD COLUMN IF NOT EXISTS scope_hash text,
  ADD COLUMN IF NOT EXISTS pricing_canonical_text text,
  ADD COLUMN IF NOT EXISTS pricing_hash text,
  ADD COLUMN IF NOT EXISTS renderer_version text,
  ADD COLUMN IF NOT EXISTS tool_version text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS frozen_at timestamptz;

-- quote_revisions in this database is the reduced table from earlier cases.
-- These columns are what a sent patio quote row in this contract carries.
-- Adding them nullable leaves every earlier insert unchanged.
ALTER TABLE public.quote_revisions
  ADD COLUMN IF NOT EXISTS scope_snapshot_json jsonb,
  ADD COLUMN IF NOT EXISTS pricing_snapshot_json jsonb,
  ADD COLUMN IF NOT EXISTS manifest_url text,
  ADD COLUMN IF NOT EXISTS manifest_hash text,
  ADD COLUMN IF NOT EXISTS pdf_url text,
  ADD COLUMN IF NOT EXISTS build_kind text;
