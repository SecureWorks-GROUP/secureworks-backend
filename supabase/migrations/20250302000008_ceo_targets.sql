-- ════════════════════════════════════════════════════════════
-- Migration 008: CEO Monthly Targets
--
-- Adds monthly business targets to org_config for the CEO
-- dashboard. These drive progress bars and gap calculations.
-- ════════════════════════════════════════════════════════════

-- Monthly revenue target
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'monthly_revenue_target', '{"amount": 180000}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- Gross margin target (%)
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'margin_target_pct', '{"amount": 30}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- Monthly jobs target (completed jobs per month)
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'monthly_jobs_target', '{"amount": 15}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- Monthly marketing budget cap
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'monthly_marketing_budget', '{"amount": 5000}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- Pipeline coverage target (multiplier — 2x means pipeline should be 2x monthly target)
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'pipeline_coverage_target', '{"amount": 2.0}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
