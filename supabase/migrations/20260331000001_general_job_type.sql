-- Add 'general' job type with SWG- prefix for Quick Quote & Invoice jobs
-- This is for general-purpose jobs (makesafe, repairs, small works)

-- Add 'general' to jobs.type CHECK constraint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check
  CHECK (type IN ('fencing', 'patio', 'combo', 'decking', 'renovation', 'insurance', 'roofing', 'miscellaneous', 'general'));

-- Update next_job_number() to support SWG- prefix
CREATE OR REPLACE FUNCTION next_job_number(job_type text DEFAULT 'patio')
RETURNS text AS $$
DECLARE
  prefix text;
  yr smallint;
  seq int;
BEGIN
  prefix := CASE lower(job_type)
    WHEN 'patio'          THEN 'SWP-'
    WHEN 'fencing'        THEN 'SWF-'
    WHEN 'decking'        THEN 'SWD-'
    WHEN 'renovation'     THEN 'SWR-'
    WHEN 'insurance'      THEN 'SWI-'
    WHEN 'roofing'        THEN 'SWR-'
    WHEN 'miscellaneous'  THEN 'SWM-'
    WHEN 'general'        THEN 'SWG-'
    ELSE 'SW-'
  END;

  yr := (EXTRACT(YEAR FROM now()) % 100)::smallint;

  INSERT INTO job_number_counters (year, last_seq)
  VALUES (yr, 1)
  ON CONFLICT (year) DO UPDATE SET last_seq = job_number_counters.last_seq + 1
  RETURNING last_seq INTO seq;

  RETURN prefix || yr::text || lpad(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;
