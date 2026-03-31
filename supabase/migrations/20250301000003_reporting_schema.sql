-- ════════════════════════════════════════════════════════════
-- Migration 003: Reporting Schema
--
-- Tables for Xero financials, Google Ads metrics,
-- contact matching (attribution), and webhook logging.
-- Views for dashboard aggregation.
-- ════════════════════════════════════════════════════════════

-- ── Xero OAuth Tokens ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS xero_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  access_token text NOT NULL,
  refresh_token text,
  token_type text DEFAULT 'Bearer',
  expires_at timestamptz NOT NULL,
  tenant_id text,             -- Xero tenant (org) ID
  scopes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(org_id)
);
ALTER TABLE xero_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on xero_tokens"
  ON xero_tokens FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Admins can view own org tokens"
  ON xero_tokens FOR SELECT
  USING (
    org_id = (SELECT org_id FROM users WHERE id = auth.uid())
    AND (SELECT role FROM users WHERE id = auth.uid()) = 'admin'
  );

-- Trigger for updated_at
CREATE TRIGGER update_xero_tokens_updated_at
  BEFORE UPDATE ON xero_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── Xero Invoices ──────────────────────────────────────────
-- Stores both ACCREC (sales) and ACCPAY (bills) for job P&L
CREATE TABLE IF NOT EXISTS xero_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  xero_invoice_id text NOT NULL,            -- Xero's InvoiceID
  xero_contact_id text,                      -- Xero's ContactID
  contact_name text,
  invoice_number text,
  invoice_type text NOT NULL,                -- ACCREC or ACCPAY
  status text,                               -- DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED
  reference text,                            -- Often contains job ref
  currency_code text DEFAULT 'AUD',
  sub_total numeric(12,2),                   -- Ex GST
  total_tax numeric(12,2),
  total numeric(12,2),                       -- Inc GST
  amount_due numeric(12,2),
  amount_paid numeric(12,2),
  invoice_date date,
  due_date date,
  fully_paid_on date,
  line_items jsonb,                          -- Array of line item objects
  job_id uuid REFERENCES jobs(id),           -- Matched to internal job
  raw_json jsonb,                            -- Full Xero response for debugging
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(org_id, xero_invoice_id)
);
ALTER TABLE xero_invoices ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_xero_invoices_org ON xero_invoices(org_id);
CREATE INDEX idx_xero_invoices_type ON xero_invoices(invoice_type);
CREATE INDEX idx_xero_invoices_date ON xero_invoices(invoice_date);
CREATE INDEX idx_xero_invoices_status ON xero_invoices(status);
CREATE INDEX idx_xero_invoices_job ON xero_invoices(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_xero_invoices_contact ON xero_invoices(xero_contact_id);

CREATE POLICY "Users view own org invoices"
  ON xero_invoices FOR SELECT
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Service role manages invoices"
  ON xero_invoices FOR ALL
  USING (auth.role() = 'service_role');

CREATE TRIGGER update_xero_invoices_updated_at
  BEFORE UPDATE ON xero_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── Xero Reports ───────────────────────────────────────────
-- Stores P&L and Aged Receivables as JSONB snapshots
CREATE TABLE IF NOT EXISTS xero_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  report_type text NOT NULL,                 -- profit_and_loss, aged_receivables, balance_sheet
  report_date date NOT NULL,                 -- Period end date
  period_start date,
  period_end date,
  report_json jsonb NOT NULL,                -- Full report data
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(org_id, report_type, report_date)
);
ALTER TABLE xero_reports ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_xero_reports_org_type ON xero_reports(org_id, report_type);
CREATE INDEX idx_xero_reports_date ON xero_reports(report_date);

CREATE POLICY "Users view own org reports"
  ON xero_reports FOR SELECT
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Service role manages reports"
  ON xero_reports FOR ALL
  USING (auth.role() = 'service_role');


-- ── Google Ads Daily Metrics ───────────────────────────────
CREATE TABLE IF NOT EXISTS google_ads_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  report_date date NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text,
  impressions integer DEFAULT 0,
  clicks integer DEFAULT 0,
  cost_micros bigint DEFAULT 0,              -- Google reports cost in micros (÷1,000,000)
  conversions numeric(10,2) DEFAULT 0,
  conversion_value numeric(12,2) DEFAULT 0,
  interactions integer DEFAULT 0,
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(org_id, report_date, campaign_id)
);
ALTER TABLE google_ads_daily ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_google_ads_daily_date ON google_ads_daily(report_date);
CREATE INDEX idx_google_ads_daily_org ON google_ads_daily(org_id);
CREATE INDEX idx_google_ads_daily_campaign ON google_ads_daily(campaign_id);

CREATE POLICY "Users view own org ads data"
  ON google_ads_daily FOR SELECT
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Service role manages ads data"
  ON google_ads_daily FOR ALL
  USING (auth.role() = 'service_role');


-- ── Contact Matches (Attribution) ──────────────────────────
-- Links GHL contacts to Xero contacts + captures ad attribution
CREATE TABLE IF NOT EXISTS contact_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  ghl_contact_id text,
  xero_contact_id text,
  job_id uuid REFERENCES jobs(id),
  email text,
  phone text,
  client_name text,
  gclid text,                                -- Google Click ID
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  lead_source text,                          -- google_ads, organic, referral, direct
  matched_at timestamptz,                    -- When GHL-Xero match was made
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE contact_matches ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_contact_matches_org ON contact_matches(org_id);
CREATE INDEX idx_contact_matches_ghl ON contact_matches(ghl_contact_id);
CREATE INDEX idx_contact_matches_xero ON contact_matches(xero_contact_id);
CREATE INDEX idx_contact_matches_email ON contact_matches(email);
CREATE INDEX idx_contact_matches_job ON contact_matches(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_contact_matches_gclid ON contact_matches(gclid) WHERE gclid IS NOT NULL;

CREATE POLICY "Users view own org matches"
  ON contact_matches FOR SELECT
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Service role manages matches"
  ON contact_matches FOR ALL
  USING (auth.role() = 'service_role');

CREATE TRIGGER update_contact_matches_updated_at
  BEFORE UPDATE ON contact_matches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── Webhook Log ────────────────────────────────────────────
-- Audit trail for all incoming webhooks
CREATE TABLE IF NOT EXISTS webhook_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  source text NOT NULL,                      -- ghl, xero, google_ads
  event_type text,
  payload jsonb,
  status text DEFAULT 'received',            -- received, processed, failed
  error_message text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE webhook_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_webhook_log_org ON webhook_log(org_id);
CREATE INDEX idx_webhook_log_source ON webhook_log(source);
CREATE INDEX idx_webhook_log_created ON webhook_log(created_at);

CREATE POLICY "Admins view own org webhooks"
  ON webhook_log FOR SELECT
  USING (
    org_id = (SELECT org_id FROM users WHERE id = auth.uid())
    AND (SELECT role FROM users WHERE id = auth.uid()) = 'admin'
  );

CREATE POLICY "Service role manages webhooks"
  ON webhook_log FOR ALL
  USING (auth.role() = 'service_role');


-- ════════════════════════════════════════════════════════════
-- VIEWS
-- ════════════════════════════════════════════════════════════

-- ── Monthly Revenue (from ACCREC invoices, ex GST) ─────────
CREATE OR REPLACE VIEW monthly_revenue AS
SELECT
  org_id,
  date_trunc('month', invoice_date)::date AS month,
  COUNT(*) AS invoice_count,
  SUM(sub_total) AS revenue,
  SUM(total_tax) AS tax,
  SUM(total) AS revenue_inc_gst,
  SUM(amount_paid) AS collected,
  SUM(amount_due) AS outstanding
FROM xero_invoices
WHERE invoice_type = 'ACCREC'
  AND status NOT IN ('VOIDED', 'DELETED', 'DRAFT')
GROUP BY org_id, date_trunc('month', invoice_date);


-- ── Monthly Costs (from ACCPAY invoices, ex GST) ──────────
CREATE OR REPLACE VIEW monthly_costs AS
SELECT
  org_id,
  date_trunc('month', invoice_date)::date AS month,
  COUNT(*) AS bill_count,
  SUM(sub_total) AS costs,
  SUM(total) AS costs_inc_gst,
  SUM(amount_paid) AS paid,
  SUM(amount_due) AS unpaid
FROM xero_invoices
WHERE invoice_type = 'ACCPAY'
  AND status NOT IN ('VOIDED', 'DELETED', 'DRAFT')
GROUP BY org_id, date_trunc('month', invoice_date);


-- ── Aged Receivables ───────────────────────────────────────
CREATE OR REPLACE VIEW aged_receivables AS
SELECT
  org_id,
  xero_contact_id,
  contact_name,
  invoice_number,
  invoice_date,
  due_date,
  amount_due,
  CASE
    WHEN due_date >= CURRENT_DATE THEN 'current'
    WHEN due_date >= CURRENT_DATE - INTERVAL '30 days' THEN '1-30'
    WHEN due_date >= CURRENT_DATE - INTERVAL '60 days' THEN '31-60'
    WHEN due_date >= CURRENT_DATE - INTERVAL '90 days' THEN '61-90'
    ELSE '90+'
  END AS age_bucket
FROM xero_invoices
WHERE invoice_type = 'ACCREC'
  AND status IN ('AUTHORISED', 'SUBMITTED')
  AND amount_due > 0;


-- ── Google Ads Monthly Aggregation ─────────────────────────
CREATE OR REPLACE VIEW google_ads_monthly AS
SELECT
  org_id,
  date_trunc('month', report_date)::date AS month,
  campaign_id,
  campaign_name,
  SUM(impressions) AS impressions,
  SUM(clicks) AS clicks,
  SUM(cost_micros)::numeric / 1000000 AS spend,
  SUM(conversions) AS conversions,
  SUM(conversion_value) AS conversion_value,
  CASE WHEN SUM(impressions) > 0
    THEN ROUND(SUM(clicks)::numeric / SUM(impressions) * 100, 2)
    ELSE 0
  END AS ctr,
  CASE WHEN SUM(clicks) > 0
    THEN ROUND((SUM(cost_micros)::numeric / 1000000) / SUM(clicks), 2)
    ELSE 0
  END AS cpc,
  CASE WHEN SUM(conversions) > 0
    THEN ROUND((SUM(cost_micros)::numeric / 1000000) / SUM(conversions), 2)
    ELSE 0
  END AS cpl
FROM google_ads_daily
GROUP BY org_id, date_trunc('month', report_date), campaign_id, campaign_name;


-- ── Pipeline Metrics (enhanced) ────────────────────────────
-- Adds lead source attribution to pipeline stats
CREATE OR REPLACE VIEW pipeline_metrics AS
SELECT
  j.org_id,
  j.status,
  COUNT(*) AS job_count,
  COALESCE(SUM((j.pricing_json->>'totalIncGST')::numeric), 0) AS total_value,
  COUNT(*) FILTER (WHERE cm.lead_source = 'google_ads' OR cm.gclid IS NOT NULL) AS google_ads_leads,
  COUNT(*) FILTER (WHERE cm.lead_source = 'organic') AS organic_leads,
  COUNT(*) FILTER (WHERE cm.lead_source = 'referral') AS referral_leads,
  COUNT(*) FILTER (WHERE cm.lead_source = 'direct') AS direct_leads,
  COUNT(*) FILTER (WHERE cm.id IS NULL) AS unattributed_leads
FROM jobs j
LEFT JOIN contact_matches cm ON cm.job_id = j.id
GROUP BY j.org_id, j.status;
