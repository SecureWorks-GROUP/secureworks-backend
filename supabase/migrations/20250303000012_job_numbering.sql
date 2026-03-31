-- ============================================================
-- Migration 012: Job Numbering & Xero Sync Columns
--
-- Adds type-prefixed job number system (SWP-25001, SWF-25002, etc.)
-- for universal linking between GHL, Supabase, and Xero.
--
-- Sequence starts at 25000 to avoid collision with existing
-- Tradify numbers (highest existing: SW23324).
-- ============================================================

-- Job number sequence
CREATE SEQUENCE IF NOT EXISTS job_number_seq START WITH 25000;

-- Add job_number column to jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_number text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_job_number
  ON jobs(job_number) WHERE job_number IS NOT NULL;

-- Add Xero link columns to jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS xero_contact_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS xero_quote_id text;

-- Expand the type constraint on jobs to include new service types.
-- The existing constraint only allows ('fencing', 'patio', 'combo').
-- We need decking, renovation, insurance, roofing for the type-prefixed job numbers.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check
  CHECK (type IN ('fencing', 'patio', 'combo', 'decking', 'renovation', 'insurance', 'roofing'));

-- Helper function to generate next job number WITH type prefix.
-- Usage: SELECT next_job_number('patio')    → 'SWP-25000'
-- Usage: SELECT next_job_number('fencing')  → 'SWF-25001'
-- Usage: SELECT next_job_number('decking')  → 'SWD-25002'
CREATE OR REPLACE FUNCTION next_job_number(job_type text DEFAULT 'patio')
RETURNS text AS $$
  SELECT CASE lower(job_type)
    WHEN 'patio'      THEN 'SWP-'
    WHEN 'fencing'    THEN 'SWF-'
    WHEN 'decking'    THEN 'SWD-'
    WHEN 'renovation' THEN 'SWR-'
    WHEN 'insurance'  THEN 'SWI-'
    WHEN 'roofing'    THEN 'SWR-'
    ELSE 'SW-'
  END || nextval('job_number_seq')::text;
$$ LANGUAGE sql;
