-- ════════════════════════════════════════════════════════════
-- Migration 005: Daily Digests + Break-Even Config
--
-- Stores generated daily digest summaries and a simple
-- config table for fixed costs (break-even calculation).
-- ════════════════════════════════════════════════════════════

-- ── Daily Digests ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  digest_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'green',    -- green, amber, red
  alert_count integer DEFAULT 0,
  digest_json jsonb NOT NULL,              -- Full digest content
  delivered boolean DEFAULT false,
  delivered_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(org_id, digest_date)
);
ALTER TABLE daily_digests ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_daily_digests_org ON daily_digests(org_id);
CREATE INDEX idx_daily_digests_date ON daily_digests(digest_date DESC);

CREATE POLICY "Users view own org digests"
  ON daily_digests FOR SELECT
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Service role manages digests"
  ON daily_digests FOR ALL
  USING (auth.role() = 'service_role');


-- ── Org Config (for break-even, thresholds, webhook URL) ────
CREATE TABLE IF NOT EXISTS org_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  config_key text NOT NULL,
  config_value jsonb NOT NULL,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(org_id, config_key)
);
ALTER TABLE org_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own org config"
  ON org_config FOR SELECT
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Admins manage own org config"
  ON org_config FOR ALL
  USING (
    org_id = (SELECT org_id FROM users WHERE id = auth.uid())
    AND (SELECT role FROM users WHERE id = auth.uid()) = 'admin'
  );

CREATE POLICY "Service role manages config"
  ON org_config FOR ALL
  USING (auth.role() = 'service_role');

-- ── Default config values ──
INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'monthly_fixed_costs', '{"amount": 45000, "description": "Rent, admin, insurance, vehicles, marketing minimum"}'),
  ('00000000-0000-0000-0000-000000000001', 'digest_webhook_url', '{"url": "", "enabled": false}'),
  ('00000000-0000-0000-0000-000000000001', 'digest_email', '{"email": "", "enabled": false}')
ON CONFLICT (org_id, config_key) DO NOTHING;


-- ── pg_cron: Daily digest at 7am AWST = 11pm UTC previous day ──
SELECT cron.schedule(
  'daily-digest',
  '0 23 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
