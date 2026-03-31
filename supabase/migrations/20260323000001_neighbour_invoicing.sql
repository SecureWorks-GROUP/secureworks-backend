-- ════════════════════════════════════════════════════════════
-- Migration: Neighbour Invoicing Support
-- Ensures job_contacts has all columns needed for the
-- multi-neighbour fencing invoicing pipeline.
-- ════════════════════════════════════════════════════════════

-- Status column for re-scope handling (removed neighbours keep their record)
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
-- Values: 'active', 'removed' (neighbour removed on re-scope but has existing invoices)

-- Ensure all needed columns exist (idempotent — safe to run multiple times)
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS site_address text;
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS is_primary boolean DEFAULT false;
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS assigned_runs jsonb;
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS contact_label text DEFAULT 'A';
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS share_percentage numeric(5,2) DEFAULT 50;
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS quote_value_ex_gst numeric(12,2) DEFAULT 0;
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS amount_invoiced numeric(12,2) DEFAULT 0;
ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2) DEFAULT 0;
