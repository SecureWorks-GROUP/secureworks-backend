-- ════════════════════════════════════════════════════════════
-- Quote-to-Cash Pipeline Infrastructure
-- Date: 2026-03-19
--
-- 1. Add 'partially_accepted' to jobs status constraint
-- 2. Add job_contact_id to job_documents for per-neighbour tracking
-- ════════════════════════════════════════════════════════════

-- 1. Expand jobs status constraint to include partially_accepted
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('draft', 'quoted', 'accepted', 'partially_accepted', 'scheduled', 'in_progress', 'complete', 'invoiced', 'cancelled', 'lost'));

-- 2. Per-neighbour quote tracking on job_documents
-- Each neighbour gets their own job_documents row (type='quote') with their own share_token
ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS job_contact_id uuid REFERENCES job_contacts(id);
CREATE INDEX IF NOT EXISTS idx_job_documents_contact ON job_documents(job_contact_id) WHERE job_contact_id IS NOT NULL;

-- 3. Ensure job_contacts has share_percentage (may already exist from earlier migration)
-- Safe to run multiple times due to IF NOT EXISTS
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS share_percentage numeric(5,2) DEFAULT 50;
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS contact_label text DEFAULT 'A';
