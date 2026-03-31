-- ════════════════════════════════════════════════════════════
-- Invoice Infrastructure — Neighbour Splits + Matching
-- Run manually in Supabase SQL editor
-- Date: 2026-03-18
-- ════════════════════════════════════════════════════════════

-- 1. job_contacts table — multiple paying clients per job (fencing neighbour splits)
CREATE TABLE IF NOT EXISTS job_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  contact_label text NOT NULL DEFAULT 'A',   -- A, B, C etc (suffix for references)
  client_name text NOT NULL,
  client_email text,
  client_phone text,
  site_address text,                          -- may differ from main job address
  xero_contact_id text,                       -- resolved Xero contact
  ghl_contact_id text,                        -- GHL contact for SMS/email
  share_percentage numeric(5,2) DEFAULT 50,   -- their share of total (e.g. 50% each for 2 neighbours)
  notes text,
  is_primary boolean DEFAULT false,           -- true = the original client on the job
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_contacts_job_id ON job_contacts(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_contacts_job_label ON job_contacts(job_id, contact_label);

-- 2. xero_invoices — add job_contact_id for neighbour-specific invoices
ALTER TABLE xero_invoices
  ADD COLUMN IF NOT EXISTS job_contact_id uuid REFERENCES job_contacts(id),
  ADD COLUMN IF NOT EXISTS reference_suffix text;  -- DEP20, FINBAL, COUNCIL, VAR1 etc

-- 3. Index for unlinked invoice matching
CREATE INDEX IF NOT EXISTS idx_xero_invoices_unlinked
  ON xero_invoices(job_id) WHERE job_id IS NULL;
