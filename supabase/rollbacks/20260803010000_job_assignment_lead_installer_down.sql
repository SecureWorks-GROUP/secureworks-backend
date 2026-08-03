-- Rollback twin for 20260803010000_job_assignment_lead_installer.sql.
--
-- Dropping the column discards every lead designation made while it existed.
-- That is acceptable precisely because the forward migration never backfilled:
-- the only data lost is deliberate operator input, and the pre-migration state
-- it returns to (no job has a named lead) is the honest one. Nothing else reads
-- is_lead, so no board stage, invoice or communication depends on it.

DROP INDEX IF EXISTS uq_job_assignments_one_lead;

ALTER TABLE job_assignments
  DROP COLUMN IF EXISTS is_lead;
