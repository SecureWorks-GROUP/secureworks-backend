-- ============================================================
-- Step 2a: Scope Tool Defaults — reference pricing for drift detection
-- ============================================================

CREATE TABLE IF NOT EXISTS scope_tool_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  category text NOT NULL,
  item_key text NOT NULL,
  item_description text NOT NULL,
  unit text NOT NULL DEFAULT 'lm',
  default_cost_rate numeric(10,2),
  default_sqm_rate numeric(10,2),
  source text DEFAULT 'patio-tool',
  last_updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE (org_id, category, item_key)
);

-- RLS
ALTER TABLE scope_tool_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON scope_tool_defaults
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "anon_read_scope_defaults" ON scope_tool_defaults
  FOR SELECT USING (true);

-- GRANTs matching existing patterns
GRANT SELECT ON scope_tool_defaults TO anon, authenticated;
GRANT ALL ON scope_tool_defaults TO service_role;

-- Step 2b: Migration for processed event tracking (Step 3 needs this)
CREATE TABLE IF NOT EXISTS processed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  processed_at timestamptz DEFAULT now(),
  processor text NOT NULL DEFAULT 'daily-digest',
  result jsonb
);

ALTER TABLE processed_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON processed_events
  FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT ON processed_events TO anon, authenticated;
GRANT ALL ON processed_events TO service_role;

CREATE INDEX idx_processed_events_event_id ON processed_events(event_id);
CREATE INDEX idx_processed_events_type ON processed_events(event_type);

-- Seed with patio-tool ROOFING_TYPES pricing
INSERT INTO scope_tool_defaults (category, item_key, item_description, unit, default_cost_rate, default_sqm_rate, source) VALUES
('roofing', 'solarspan75', 'SolarSpan 75mm insulated panel', 'lm', 110.00, 620.00, 'patio-tool'),
('roofing', 'solarspan100', 'SolarSpan 100mm insulated panel', 'lm', 130.00, 680.00, 'patio-tool'),
('roofing', 'trimdek', 'Trimdek non-insulated roofing', 'lm', 15.00, NULL, 'patio-tool'),
('roofing', 'corrugated', 'Corrugated non-insulated roofing', 'lm', 12.04, NULL, 'patio-tool'),
('roofing', 'spandek', 'Spandek non-insulated roofing', 'lm', 14.50, NULL, 'patio-tool'),
('roofing', 'spanplus330', 'SpanPlus 330 non-insulated roofing', 'lm', 12.04, NULL, 'patio-tool')
ON CONFLICT (org_id, category, item_key) DO NOTHING;
