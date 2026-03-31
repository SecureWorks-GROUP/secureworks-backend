-- ============================================================
-- Migration: AI Intelligence Layer tables
-- Run in Supabase SQL Editor
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- AI ALERTS — proactive fire prevention alerts
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_alerts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES organisations(id),
  job_id              uuid REFERENCES jobs(id) ON DELETE SET NULL,
  alert_type          text NOT NULL,
  severity            text NOT NULL CHECK (severity IN ('red', 'amber')),
  message             text NOT NULL,
  recommended_action  text,
  financial_impact    numeric(12,2),
  detail_json         jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz DEFAULT now(),
  dismissed_at        timestamptz,
  dismissed_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at         timestamptz,
  resolved_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_ai_alerts_org ON ai_alerts(org_id);
CREATE INDEX idx_ai_alerts_job ON ai_alerts(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_ai_alerts_severity ON ai_alerts(severity);
CREATE INDEX idx_ai_alerts_active ON ai_alerts(org_id) WHERE dismissed_at IS NULL AND resolved_at IS NULL;

ALTER TABLE ai_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view org alerts"
  ON ai_alerts FOR SELECT
  USING (true);

CREATE POLICY "Service role manages alerts"
  ON ai_alerts FOR ALL
  USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- WEEKLY REPORTS — stored executive pulse reports
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weekly_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES organisations(id),
  week_start      date NOT NULL,
  report_json     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_narrative    text,
  created_at      timestamptz DEFAULT now(),

  UNIQUE(org_id, week_start)
);

CREATE INDEX idx_weekly_reports_org ON weekly_reports(org_id);

ALTER TABLE weekly_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view org weekly reports"
  ON weekly_reports FOR SELECT
  USING (true);

CREATE POLICY "Service role manages weekly reports"
  ON weekly_reports FOR ALL
  USING (auth.role() = 'service_role');
