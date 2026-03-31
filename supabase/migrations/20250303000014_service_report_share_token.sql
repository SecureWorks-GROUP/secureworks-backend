-- ════════════════════════════════════════════════════════════
-- Migration 014: Service Report Share Token
--
-- Adds share_token to job_service_reports so submitted reports
-- can be viewed by homeowners via a public link.
-- ════════════════════════════════════════════════════════════

ALTER TABLE job_service_reports
  ADD COLUMN IF NOT EXISTS share_token text UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex');

CREATE INDEX IF NOT EXISTS idx_service_reports_token ON job_service_reports(share_token);
