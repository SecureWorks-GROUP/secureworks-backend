-- ════════════════════════════════════════════════════════════
-- Migration 007: Granular Google Ads Data
--
-- Adds ad group level data to google_ads_daily and creates
-- separate tables for keyword + landing page performance.
-- ════════════════════════════════════════════════════════════

-- ── Add ad group columns to existing table ─────────────────
ALTER TABLE google_ads_daily
  ADD COLUMN IF NOT EXISTS ad_group_id text DEFAULT '',
  ADD COLUMN IF NOT EXISTS ad_group_name text;

-- Drop old unique constraint and recreate with ad_group_id
-- (existing rows get ad_group_id = '' so they stay unique)
ALTER TABLE google_ads_daily
  DROP CONSTRAINT IF EXISTS google_ads_daily_org_id_report_date_campaign_id_key;

ALTER TABLE google_ads_daily
  ADD CONSTRAINT google_ads_daily_unique_key
  UNIQUE (org_id, report_date, campaign_id, ad_group_id);

CREATE INDEX IF NOT EXISTS idx_google_ads_daily_adgroup
  ON google_ads_daily(ad_group_id) WHERE ad_group_id != '';


-- ── Google Ads Keywords (daily) ────────────────────────────
CREATE TABLE IF NOT EXISTS google_ads_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  report_date date NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text,
  ad_group_id text NOT NULL,
  ad_group_name text,
  keyword_text text NOT NULL,
  match_type text,                   -- EXACT, PHRASE, BROAD
  impressions integer DEFAULT 0,
  clicks integer DEFAULT 0,
  cost_micros bigint DEFAULT 0,
  conversions numeric(10,2) DEFAULT 0,
  synced_at timestamptz DEFAULT now(),
  UNIQUE(org_id, report_date, campaign_id, ad_group_id, keyword_text, match_type)
);
ALTER TABLE google_ads_keywords ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_ads_keywords_org ON google_ads_keywords(org_id);
CREATE INDEX idx_ads_keywords_date ON google_ads_keywords(report_date);

CREATE POLICY "Users view own keywords"
  ON google_ads_keywords FOR SELECT
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));
CREATE POLICY "Service role manages keywords"
  ON google_ads_keywords FOR ALL
  USING (auth.role() = 'service_role');


-- ── Google Ads Landing Pages (daily) ───────────────────────
CREATE TABLE IF NOT EXISTS google_ads_landing_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  report_date date NOT NULL,
  campaign_id text,
  landing_page_url text NOT NULL,
  impressions integer DEFAULT 0,
  clicks integer DEFAULT 0,
  cost_micros bigint DEFAULT 0,
  conversions numeric(10,2) DEFAULT 0,
  synced_at timestamptz DEFAULT now(),
  UNIQUE(org_id, report_date, landing_page_url)
);
ALTER TABLE google_ads_landing_pages ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_ads_landing_org ON google_ads_landing_pages(org_id);
CREATE INDEX idx_ads_landing_date ON google_ads_landing_pages(report_date);

CREATE POLICY "Users view own landing pages"
  ON google_ads_landing_pages FOR SELECT
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));
CREATE POLICY "Service role manages landing pages"
  ON google_ads_landing_pages FOR ALL
  USING (auth.role() = 'service_role');


-- ── Update google_ads_monthly view to include ad group data ──
-- Must DROP + CREATE because adding columns shifts positions
DROP VIEW IF EXISTS google_ads_monthly;
CREATE VIEW google_ads_monthly AS
SELECT
  org_id,
  date_trunc('month', report_date)::date AS month,
  campaign_id,
  campaign_name,
  ad_group_id,
  ad_group_name,
  SUM(impressions) AS impressions,
  SUM(clicks) AS clicks,
  SUM(cost_micros) / 1000000.0 AS spend,
  SUM(conversions) AS conversions,
  SUM(conversion_value) AS conversion_value,
  CASE WHEN SUM(impressions) > 0
    THEN ROUND(SUM(clicks)::numeric / SUM(impressions) * 100, 2)
    ELSE 0
  END AS ctr,
  CASE WHEN SUM(conversions) > 0
    THEN ROUND(SUM(cost_micros) / 1000000.0 / SUM(conversions), 2)
    ELSE 0
  END AS cpl
FROM google_ads_daily
GROUP BY org_id, date_trunc('month', report_date), campaign_id, campaign_name, ad_group_id, ad_group_name;
