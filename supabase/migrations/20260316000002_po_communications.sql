-- ============================================================
-- Migration: po_communications table + unmatched_emails
-- Run in Supabase SQL Editor
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PO COMMUNICATIONS — email thread per purchase order
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_communications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id           uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  job_id          uuid REFERENCES jobs(id) ON DELETE SET NULL,
  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_email      text,
  to_email        text,
  subject         text,
  body_text       text,
  body_html       text,
  attachments_json jsonb DEFAULT '[]'::jsonb,
  sent_at         timestamptz,
  received_at     timestamptz,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_po_comms_po ON po_communications(po_id);
CREATE INDEX idx_po_comms_job ON po_communications(job_id);
CREATE INDEX idx_po_comms_dir ON po_communications(direction);

ALTER TABLE po_communications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view org PO comms"
  ON po_communications FOR SELECT
  USING (true);

CREATE POLICY "Service role manages PO comms"
  ON po_communications FOR ALL
  USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- UNMATCHED EMAILS — inbound emails that couldn't be routed
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unmatched_emails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_email      text,
  to_email        text,
  subject         text,
  body_text       text,
  body_html       text,
  attachments_json jsonb DEFAULT '[]'::jsonb,
  received_at     timestamptz,
  reviewed        boolean DEFAULT false,
  reviewed_at     timestamptz,
  notes           text,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE unmatched_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages unmatched emails"
  ON unmatched_emails FOR ALL
  USING (auth.role() = 'service_role');
