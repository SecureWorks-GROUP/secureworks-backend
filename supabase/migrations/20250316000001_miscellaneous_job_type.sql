-- ============================================================
-- Migration: Add 'miscellaneous' to job type constraint + SWM prefix
--
-- NOTE: Run this manually in Supabase SQL editor before using Quick Quote.
-- ============================================================

-- Expand type constraint to include 'miscellaneous'
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check
  CHECK (type IN ('fencing', 'patio', 'combo', 'decking', 'renovation', 'insurance', 'roofing', 'miscellaneous'));

-- Update next_job_number() to support SWM- prefix for miscellaneous jobs
CREATE OR REPLACE FUNCTION next_job_number(job_type text DEFAULT 'patio')
RETURNS text AS $$
  SELECT CASE lower(job_type)
    WHEN 'patio'          THEN 'SWP-'
    WHEN 'fencing'        THEN 'SWF-'
    WHEN 'decking'        THEN 'SWD-'
    WHEN 'renovation'     THEN 'SWR-'
    WHEN 'insurance'      THEN 'SWI-'
    WHEN 'roofing'        THEN 'SWR-'
    WHEN 'miscellaneous'  THEN 'SWM-'
    ELSE 'SW-'
  END || nextval('job_number_seq')::text;
$$ LANGUAGE sql;
