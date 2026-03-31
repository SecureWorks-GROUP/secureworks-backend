-- ════════════════════════════════════════════════════════════
-- Job Contacts — Neighbour splits for fencing jobs
-- Allows invoicing multiple clients per job (A/B/C/D)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS job_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jobs(id),
  contact_type    text NOT NULL DEFAULT 'primary',  -- 'primary', 'neighbour_b', 'neighbour_c', 'neighbour_d'
  client_name     text NOT NULL,
  client_phone    text,
  client_email    text,
  xero_contact_id text,
  ghl_contact_id  text,
  quote_value_ex_gst numeric(12,2) DEFAULT 0,
  amount_invoiced numeric(12,2) DEFAULT 0,
  amount_paid     numeric(12,2) DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_contacts_job ON job_contacts(job_id);

-- Reference convention for neighbour splits:
-- SWF-25030-A-DEP50  (primary client, deposit 50%)
-- SWF-25030-B-DEP50  (neighbour B, deposit 50%)
-- SWF-25030-A-FINBAL (primary client, final balance)
-- The suffix letter maps to contact_type: primary=A, neighbour_b=B, neighbour_c=C, neighbour_d=D
