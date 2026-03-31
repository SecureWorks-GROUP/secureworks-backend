-- ════════════════════════════════════════════════════════════
-- Migration 014: Invoice Verification Columns on job_assignments
--
-- Adds columns needed by Phase 2 verification chain:
--   verified_at, verified_by — lead approves labourer hours
--   dispute_reason, disputed_by, disputed_at — lead disputes hours
--   hours_worked — calculated billable hours
--   manual_override — flag for manually adjusted times
--
-- Also expands status constraint to include 'submitted', 'verified', 'draft', 'disputed'
-- Also expands role constraint to include 'crew' (labourers like Ryan)
-- ════════════════════════════════════════════════════════════

-- Add verification columns
ALTER TABLE job_assignments
  ADD COLUMN IF NOT EXISTS verified_at    timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by    uuid,
  ADD COLUMN IF NOT EXISTS dispute_reason text,
  ADD COLUMN IF NOT EXISTS disputed_by    uuid,
  ADD COLUMN IF NOT EXISTS disputed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS hours_worked   numeric(6,2),
  ADD COLUMN IF NOT EXISTS manual_override boolean DEFAULT false;

-- Expand status constraint to support verification flow
-- Old: 'scheduled', 'confirmed', 'in_progress', 'complete', 'cancelled'
-- New: adds 'submitted', 'verified', 'draft', 'disputed'
ALTER TABLE job_assignments DROP CONSTRAINT IF EXISTS job_assignments_status_check;
ALTER TABLE job_assignments ADD CONSTRAINT job_assignments_status_check
  CHECK (status IN ('scheduled', 'confirmed', 'in_progress', 'complete', 'cancelled', 'submitted', 'verified', 'draft', 'disputed'));

-- Expand role constraint to include 'crew' for labourers
ALTER TABLE job_assignments DROP CONSTRAINT IF EXISTS job_assignments_role_check;
ALTER TABLE job_assignments ADD CONSTRAINT job_assignments_role_check
  CHECK (role IN ('lead_installer', 'helper', 'estimator', 'crew', 'lead'));
