-- ════════════════════════════════════════════════════════════
-- Migration 009: Additional KPI Targets + Sync Schedules
--
-- 1. Seeds 5 new org_config targets for KPI scorecard:
--    DSO, Cycle Time, Cost-to-Revenue, Concentration Risk, Win Rate
-- 2. Adds pg_cron schedules for sync_projects and sync_tracking_pl
--    (these were missing — job P&L data was only refreshing on manual call)
-- ════════════════════════════════════════════════════════════

-- ── New KPI Targets ──

-- DSO target (days) — collecting within 30 days is healthy
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'dso_target', '{"amount": 30}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- Cycle time target (days) — draft to complete in 60 days
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'cycle_time_target', '{"amount": 60}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- Cost-to-revenue ratio target (%) — below 70% is healthy
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'cost_to_revenue_target', '{"amount": 70}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- Customer concentration risk threshold (%) — top 5 clients < 50% of revenue
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'concentration_risk_threshold', '{"amount": 50}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- Win rate target (%) — 40%+ quote-to-win
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'win_rate_target', '{"amount": 40}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- ── pg_cron: Xero Projects Sync (daily at 6:15am AWST = 10:15pm UTC) ──
-- Pulls per-project revenue + expenses for job P&L
SELECT cron.schedule(
  'xero-projects-sync',
  '15 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_projects',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── pg_cron: Xero Tracking P&L Sync (daily at 6:30am AWST = 10:30pm UTC) ──
-- Pulls monthly P&L by business unit for revenue breakdown
SELECT cron.schedule(
  'xero-tracking-pl-sync',
  '30 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_tracking_pl',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
