-- Add assigned_runs column to job_contacts for per-run neighbour cost mapping
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS assigned_runs jsonb DEFAULT NULL;

COMMENT ON COLUMN job_contacts.assigned_runs IS 'Array of run names assigned to this contact (per-run cost split method)';
