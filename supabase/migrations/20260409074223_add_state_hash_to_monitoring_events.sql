-- DEV-NUDGE-STATE-CHECK: Add state hash column for dedup
-- Allows isDuplicate to skip re-nudging when job state hasn't changed
ALTER TABLE monitoring_events ADD COLUMN IF NOT EXISTS state_hash text;
