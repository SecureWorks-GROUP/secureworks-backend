-- Add 'lost' to jobs status constraint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('draft', 'quoted', 'accepted', 'scheduled', 'in_progress', 'complete', 'invoiced', 'cancelled', 'lost'));
