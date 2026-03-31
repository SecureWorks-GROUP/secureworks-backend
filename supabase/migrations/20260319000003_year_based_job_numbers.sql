-- ============================================================
-- Migration: Year-based job numbering
--
-- Changes job numbers from global sequence (SWP-25001, SWP-25002...)
-- to year-prefixed sequential numbers (SWP-26001, SWP-26002...).
-- Rolls automatically: 2027 → SWP-27001, etc.
--
-- Existing jobs keep their current numbers. Only new jobs get
-- the year-based format.
--
-- NOTE: Run this manually in Supabase SQL editor.
-- ============================================================

-- Counter table: one row per year, tracks last assigned sequence
CREATE TABLE IF NOT EXISTS job_number_counters (
  year smallint PRIMARY KEY,
  last_seq int NOT NULL DEFAULT 0
);

-- Seed 2026 at 0 (first job will be 26001)
INSERT INTO job_number_counters (year, last_seq)
VALUES (26, 0)
ON CONFLICT (year) DO NOTHING;

-- Replace the function to use year-aware counter instead of global sequence
CREATE OR REPLACE FUNCTION next_job_number(job_type text DEFAULT 'patio')
RETURNS text AS $$
DECLARE
  prefix text;
  yr smallint;
  seq int;
BEGIN
  -- Determine type prefix
  prefix := CASE lower(job_type)
    WHEN 'patio'          THEN 'SWP-'
    WHEN 'fencing'        THEN 'SWF-'
    WHEN 'decking'        THEN 'SWD-'
    WHEN 'renovation'     THEN 'SWR-'
    WHEN 'insurance'      THEN 'SWI-'
    WHEN 'roofing'        THEN 'SWR-'
    WHEN 'miscellaneous'  THEN 'SWM-'
    ELSE 'SW-'
  END;

  -- Get 2-digit year
  yr := (EXTRACT(YEAR FROM now()) % 100)::smallint;

  -- Atomically increment counter for this year (insert if first job of new year)
  INSERT INTO job_number_counters (year, last_seq)
  VALUES (yr, 1)
  ON CONFLICT (year) DO UPDATE SET last_seq = job_number_counters.last_seq + 1
  RETURNING last_seq INTO seq;

  -- Return e.g. SWP-26001, SWF-26002
  RETURN prefix || yr::text || lpad(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;
