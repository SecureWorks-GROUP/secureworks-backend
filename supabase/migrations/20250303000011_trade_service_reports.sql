-- ════════════════════════════════════════════════════════════
-- Migration 011: Trade Service Reports
--
-- Adds job_service_reports table for trade completion sign-off
-- (checklist + notes + homeowner signature). Seeds default
-- checklist templates in org_config.
-- ════════════════════════════════════════════════════════════

-- ── 1. Service Reports Table ──

CREATE TABLE IF NOT EXISTS job_service_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  submitted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  checklist_json  jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes           text,
  signature_data  text,       -- base64 PNG from canvas
  signature_name  text,       -- typed homeowner name
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'submitted', 'approved')),
  submitted_at    timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_service_reports_job ON job_service_reports(job_id);
CREATE INDEX idx_service_reports_status ON job_service_reports(status);

ALTER TABLE job_service_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view org service reports"
  ON job_service_reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM jobs j WHERE j.id = job_service_reports.job_id
        AND j.org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
    )
  );

CREATE POLICY "Service role manages service reports"
  ON job_service_reports FOR ALL
  USING (auth.role() = 'service_role');

CREATE TRIGGER trg_service_reports_updated BEFORE UPDATE ON job_service_reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 2. Seed default checklist templates ──

INSERT INTO org_config (org_id, config_key, config_value) VALUES
  (
    '00000000-0000-0000-0000-000000000001',
    'service_checklist_patio',
    '{
      "items": [
        "All posts plumb and footings backfilled",
        "Beams and rafters secured — no loose bolts",
        "Roof sheets fixed and sealed (no visible gaps)",
        "Gutters and downpipes connected and draining",
        "Flashings installed and sealed to house wall",
        "All steelwork touched up — no scratches or chips",
        "Site cleaned — offcuts, packaging, concrete removed",
        "Client walkthrough completed"
      ]
    }'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000000001',
    'service_checklist_fencing',
    '{
      "items": [
        "All posts plumb and concreted",
        "Rails level and securely fastened",
        "Sheets fixed with no gaps or rattling",
        "Gates swing freely and latch correctly",
        "Exposed cuts and edges capped or trimmed",
        "Site cleaned — offcuts, packaging, concrete removed",
        "Client walkthrough completed"
      ]
    }'::jsonb
  )
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
