-- Add new pipeline stage timestamp columns
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS approvals_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deposit_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pre_build_at timestamptz;
