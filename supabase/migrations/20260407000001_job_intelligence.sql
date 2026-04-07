-- Job Intelligence Layer
-- AI-computed intelligence per job: risk, health, margin, KPI breaches, AI summary

CREATE TABLE IF NOT EXISTS job_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  job_id UUID NOT NULL REFERENCES jobs(id),

  -- AI Assessment
  risk_level TEXT DEFAULT 'unknown',
  health_score INTEGER,
  client_quality_score INTEGER,
  margin_forecast_pct INTEGER,
  margin_forecast_amount INTEGER,

  -- Structured intelligence
  things_to_know JSONB DEFAULT '[]',
  next_actions JSONB DEFAULT '[]',
  financials JSONB DEFAULT '{}',
  communications_summary JSONB DEFAULT '{}',
  materials_status JSONB DEFAULT '{}',
  schedule_status JSONB DEFAULT '{}',

  -- Stale detection
  days_in_current_stage INTEGER,
  last_activity_at TIMESTAMPTZ,
  stale BOOLEAN DEFAULT false,
  responsible_person TEXT,

  -- CEO additions
  decision_log JSONB DEFAULT '[]',

  -- AI narrative
  ai_summary TEXT,

  -- Metadata
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  stale_after TIMESTAMPTZ,
  computation_cost_usd NUMERIC(6,4),

  UNIQUE(job_id)
);

CREATE INDEX idx_job_intel_job ON job_intelligence(job_id);
CREATE INDEX idx_job_intel_risk ON job_intelligence(risk_level);
CREATE INDEX idx_job_intel_health ON job_intelligence(health_score);
CREATE INDEX idx_job_intel_stale ON job_intelligence(stale) WHERE stale = true;

ALTER TABLE job_intelligence ENABLE ROW LEVEL SECURITY;
GRANT ALL ON job_intelligence TO service_role;
CREATE POLICY "service_role_all" ON job_intelligence FOR ALL TO service_role USING (true) WITH CHECK (true);
