-- ============================================================
-- Migration: Intelligence Layer — CloudEvents, reasoning traces,
-- feedback loops, action permissions, financial snapshots
-- Run in Supabase SQL Editor
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- BUSINESS EVENTS — immutable append-only event log (CloudEvents)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_number   bigserial UNIQUE,
  event_type        text NOT NULL,
  source            text NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  entity_type       text NOT NULL,
  entity_id         text NOT NULL,
  correlation_id    uuid,
  causation_id      uuid,
  job_id            text,
  payload           jsonb NOT NULL DEFAULT '{}',
  metadata          jsonb NOT NULL DEFAULT '{}',
  schema_version    text NOT NULL DEFAULT '1.0'
);

CREATE INDEX idx_events_entity ON business_events(entity_type, entity_id);
CREATE INDEX idx_events_job ON business_events(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_events_type ON business_events(event_type);
CREATE INDEX idx_events_correlation ON business_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_events_occurred ON business_events(occurred_at DESC);
CREATE INDEX idx_events_payload ON business_events USING GIN (payload jsonb_path_ops);

ALTER TABLE business_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "insert_only" ON business_events FOR INSERT WITH CHECK (true);
CREATE POLICY "select_all" ON business_events FOR SELECT USING (true);

COMMENT ON TABLE business_events IS 'Immutable append-only log of all business operations using CloudEvents envelope';
COMMENT ON COLUMN business_events.correlation_id IS 'Shared UUID linking all events in one job lifecycle workflow';
COMMENT ON COLUMN business_events.causation_id IS 'UUID of the specific event that triggered this one';
COMMENT ON COLUMN business_events.payload IS 'JSONB with entity, changes, financial, related_entities, estimated_vs_actual keys';


-- ────────────────────────────────────────────────────────────
-- AI REASONING TRACES — Langfuse-inspired observability
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_reasoning_traces (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  trigger_type              text NOT NULL,
  trigger_reference_id      uuid,
  correlation_id            uuid,
  model_name                text NOT NULL,
  prompt_template_version   text,
  input_context_snapshot    jsonb NOT NULL,
  input_context_hash        text,
  reasoning_summary         text,
  reasoning_full            text,
  confidence_score          numeric(4,3) CHECK (confidence_score BETWEEN 0 AND 1),
  confidence_breakdown      jsonb,
  dismissed_hypotheses      jsonb DEFAULT '[]',
  output_result             jsonb NOT NULL,
  output_type               text NOT NULL,
  input_tokens              integer,
  output_tokens             integer,
  cost_usd                  numeric(10,6),
  latency_ms                integer,
  iteration_count           integer DEFAULT 1,
  max_iterations            integer DEFAULT 10,
  status                    text DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed', 'killed')),
  storage_tier              text DEFAULT 'full' CHECK (storage_tier IN ('full', 'summarized', 'archived')),
  tags                      text[] DEFAULT '{}'
);

CREATE INDEX idx_traces_created ON ai_reasoning_traces(created_at DESC);
CREATE INDEX idx_traces_correlation ON ai_reasoning_traces(correlation_id);
CREATE INDEX idx_traces_output_type ON ai_reasoning_traces(output_type);

COMMENT ON TABLE ai_reasoning_traces IS 'Complete chain-of-thought log for every AI analysis cycle';
COMMENT ON COLUMN ai_reasoning_traces.input_context_snapshot IS 'CRITICAL: frozen copy of exact data the AI saw, for debugging wrong recommendations later';

ALTER TABLE ai_reasoning_traces ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_manages_traces" ON ai_reasoning_traces FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "users_read_traces" ON ai_reasoning_traces FOR SELECT USING (true);


-- ────────────────────────────────────────────────────────────
-- AI DECISION LINKS — connects reasoning to outputs
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_decision_links (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id                uuid NOT NULL REFERENCES ai_reasoning_traces(id),
  decision_type           text NOT NULL,
  decision_reference_id   uuid,
  decision_reference_table text,
  decision_summary        text NOT NULL,
  confidence_at_decision  numeric(4,3),
  priority                text CHECK (priority IN ('critical', 'high', 'medium', 'low', 'info')),
  created_at              timestamptz DEFAULT now()
);

CREATE INDEX idx_decision_links_trace ON ai_decision_links(trace_id);

ALTER TABLE ai_decision_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_manages_links" ON ai_decision_links FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "users_read_links" ON ai_decision_links FOR SELECT USING (true);


-- ────────────────────────────────────────────────────────────
-- AI FEEDBACK OUTCOMES — closes the self-improvement loop
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_feedback_outcomes (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id                  uuid NOT NULL REFERENCES ai_reasoning_traces(id),
  decision_link_id          uuid REFERENCES ai_decision_links(id),
  human_action              text NOT NULL,
  human_action_at           timestamptz,
  human_modification        jsonb,
  human_notes               text,
  actual_outcome            jsonb,
  outcome_recorded_at       timestamptz,
  prediction_accuracy_score numeric(4,3),
  feedback_category         text,
  lessons_learned           text,
  created_at                timestamptz DEFAULT now()
);

CREATE INDEX idx_feedback_trace ON ai_feedback_outcomes(trace_id);
CREATE INDEX idx_feedback_category ON ai_feedback_outcomes(feedback_category);

COMMENT ON TABLE ai_feedback_outcomes IS 'Human responses to AI proposals + actual outcomes - the self-improvement data source';

ALTER TABLE ai_feedback_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_manages_feedback" ON ai_feedback_outcomes FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "users_read_feedback" ON ai_feedback_outcomes FOR SELECT USING (true);


-- ────────────────────────────────────────────────────────────
-- AI SCORES — flexible evaluation system
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_scores (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id  uuid NOT NULL REFERENCES ai_reasoning_traces(id),
  name      text NOT NULL,
  value     numeric,
  data_type text DEFAULT 'NUMERIC',
  source    text NOT NULL,
  comment   text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_scores_trace ON ai_scores(trace_id);

ALTER TABLE ai_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_manages_scores" ON ai_scores FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "users_read_scores" ON ai_scores FOR SELECT USING (true);


-- ────────────────────────────────────────────────────────────
-- AI PROPOSED ACTIONS — pending state for HITL approval
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_proposed_actions (
  proposal_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id          uuid NOT NULL REFERENCES ai_reasoning_traces(id),
  action_type       text NOT NULL,
  action_payload    jsonb NOT NULL,
  confidence_score  numeric(4,3),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'auto_approved', 'approved', 'rejected', 'expired')),
  auto_threshold    numeric(4,3) DEFAULT 0.870,
  ai_processed_at   timestamptz,
  resolved_at       timestamptz,
  resolved_by       uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_proposals_pending ON ai_proposed_actions(status) WHERE status = 'pending';

ALTER TABLE ai_proposed_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_manages_proposals" ON ai_proposed_actions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "users_read_proposals" ON ai_proposed_actions FOR SELECT USING (true);


-- ────────────────────────────────────────────────────────────
-- ACTION PERMISSIONS — autonomy tiers
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS action_permissions (
  action_type       text PRIMARY KEY,
  risk_level        text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  autonomy_level    text NOT NULL CHECK (autonomy_level IN ('auto', 'notify', 'approve', 'block')),
  max_dollar_amount numeric(12,2),
  daily_limit       integer,
  description       text
);

INSERT INTO action_permissions VALUES
  ('generate_report', 'low', 'auto', NULL, NULL, 'AI generates reports automatically'),
  ('send_alert', 'low', 'auto', NULL, 50, 'AI sends alerts up to 50/day'),
  ('suggest_price_update', 'medium', 'notify', NULL, NULL, 'AI suggests, human reviews'),
  ('suggest_schedule', 'medium', 'notify', NULL, NULL, 'AI suggests schedule changes'),
  ('send_client_sms', 'high', 'approve', NULL, 10, 'Must be human-approved'),
  ('update_material_price', 'high', 'approve', 5000, NULL, 'Must be human-approved'),
  ('create_invoice', 'high', 'approve', NULL, NULL, 'Must be human-approved'),
  ('approve_change_order', 'critical', 'block', NULL, NULL, 'AI cannot do this')
ON CONFLICT (action_type) DO NOTHING;

COMMENT ON TABLE action_permissions IS 'Controls what the AI can do autonomously vs what needs human approval';

ALTER TABLE action_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_read_permissions" ON action_permissions FOR SELECT USING (true);
CREATE POLICY "service_manages_permissions" ON action_permissions FOR ALL USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- FINANCIAL SNAPSHOTS — pre-computed intelligence
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_snapshots (
  snapshot_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  trace_id                uuid,
  period_type             text NOT NULL CHECK (period_type IN ('daily', 'weekly', 'monthly', 'quarterly')),
  period_date             date NOT NULL,
  revenue_invoiced        numeric(12,2),
  revenue_collected       numeric(12,2),
  unbilled_revenue        numeric(12,2),
  outstanding_receivables numeric(12,2),
  outstanding_payables    numeric(12,2),
  bank_balance            numeric(12,2),
  upcoming_po_costs       numeric(12,2),
  gross_margin_pct        numeric(5,2),
  jobs_completed          integer,
  jobs_in_progress        integer,
  pnl_narrative           text,
  cash_flow_projection    jsonb,
  division_stats          jsonb,
  cost_trend_alerts       jsonb,
  executive_summary       text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, period_type, period_date)
);

COMMENT ON TABLE financial_snapshots IS 'Pre-computed financial intelligence combining Xero accrual data with operational job data';

ALTER TABLE financial_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_read_snapshots" ON financial_snapshots FOR SELECT USING (true);
CREATE POLICY "service_manages_snapshots" ON financial_snapshots FOR ALL USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- MATERIAL PRICE LEDGER — supplier price intelligence
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS material_price_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  supplier_name text NOT NULL,
  item_description text NOT NULL,
  material_category text,
  material_code text,
  unit text,
  unit_price numeric(12,2) NOT NULL,
  po_id uuid REFERENCES purchase_orders(id),
  job_id uuid REFERENCES jobs(id),
  trace_id uuid,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  confirmed_by uuid,
  confirmed_at timestamptz,
  dismiss_reason text,
  scope_tool_field text,
  previous_rate numeric(12,2),
  captured_at timestamptz DEFAULT now()
);

CREATE INDEX idx_price_ledger_supplier ON material_price_ledger(supplier_name);
CREATE INDEX idx_price_ledger_material ON material_price_ledger(material_code);
CREATE INDEX idx_price_ledger_pending ON material_price_ledger(status) WHERE status = 'pending';

COMMENT ON TABLE material_price_ledger IS 'Live supplier pricing database captured from confirmed POs - feeds scope tool accuracy';

ALTER TABLE material_price_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_read_ledger" ON material_price_ledger FOR SELECT USING (true);
CREATE POLICY "service_manages_ledger" ON material_price_ledger FOR ALL USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- MARKET INTELLIGENCE — external world knowledge
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_intelligence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  scan_date       date NOT NULL,
  category        text NOT NULL,
  summary         text NOT NULL,
  source_urls     jsonb DEFAULT '[]'::jsonb,
  relevance       text CHECK (relevance IN ('high', 'medium', 'low')),
  action_suggested text,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE market_intelligence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_read_intel" ON market_intelligence FOR SELECT USING (true);
CREATE POLICY "service_manages_intel" ON market_intelligence FOR ALL USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- COMMENT ON existing tables for MCP readiness
-- ────────────────────────────────────────────────────────────
COMMENT ON TABLE jobs IS 'Central entity - all construction jobs from lead to completion';
COMMENT ON COLUMN jobs.pricing_json IS 'Scope tool output: line items, material costs, labour, total. Keys vary by tool version.';
COMMENT ON COLUMN jobs.created_by IS 'UUID of the salesperson who created the job - used for performance analysis';
COMMENT ON COLUMN jobs.scope_json IS 'Full scoping tool state - patio dimensions, materials, configuration';
COMMENT ON TABLE purchase_orders IS 'Material and labour purchase orders linked to jobs';
COMMENT ON TABLE xero_invoices IS 'Sales invoices and bills synced from Xero accounting';
COMMENT ON TABLE job_assignments IS 'Crew scheduling - links jobs to users with dates, times, and assignment types';
COMMENT ON TABLE job_events IS 'Legacy event log - being superseded by business_events';
COMMENT ON TABLE users IS 'Team members - salespeople, ops manager, installers';
COMMENT ON TABLE ai_alerts IS 'Proactive warnings from daily-digest - short-lived, dismissed or resolved';
COMMENT ON TABLE weekly_reports IS 'Periodic business analysis snapshots for CEO dashboard';
COMMENT ON TABLE crew_availability IS 'Crew scheduling availability - available, unavailable, or on leave per date';
