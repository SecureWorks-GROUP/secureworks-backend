-- ════════════════════════════════════════════════════════════
-- Auto-assign job_number on INSERT when NULL
--
-- Prevents future phantom jobs: GHL webhook, bulk sync, and
-- scoping tool all INSERT without calling next_job_number().
-- This trigger ensures every NEW job gets a number automatically.
--
-- Fault-tolerant: if next_job_number() fails for any reason,
-- the INSERT proceeds with job_number = NULL rather than
-- blocking the job creation.
--
-- NOTE: Does NOT backfill existing NULL jobs. That requires
-- separate impact analysis (Fix 2 phantom filter depends on
-- job_number being NULL for certain scheduled jobs).
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION auto_assign_job_number()
RETURNS trigger AS $$
BEGIN
  IF NEW.job_number IS NULL THEN
    BEGIN
      NEW.job_number := next_job_number(COALESCE(NEW.type, 'patio'));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'auto_assign_job_number failed: %, allowing INSERT with NULL', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auto_job_number
  BEFORE INSERT ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION auto_assign_job_number();
