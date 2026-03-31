-- ══════════════════════════════════════════════════════════════
-- SecureWorks Suite — Priority 1 Migrations (2026-03-17)
-- Paste into Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────
-- 1a. LABOUR PO RECONCILIATION — DB Changes
-- ────────────────────────────────────────────────────────────

-- Add hourly_rate default to users table (convenience — trade_rates is still the canonical source)
ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate numeric(8,2) DEFAULT 30.00;

-- Add delivery_confirmed_at to purchase_orders (for material delivery check SMS flow)
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_confirmed_at timestamptz;

-- Backfill users.hourly_rate from latest trade_rates
UPDATE users u SET hourly_rate = tr.hourly_rate
FROM (
  SELECT DISTINCT ON (user_id) user_id, hourly_rate
  FROM trade_rates
  WHERE effective_to IS NULL
  ORDER BY user_id, effective_from DESC
) tr
WHERE u.id = tr.user_id AND (u.hourly_rate IS NULL OR u.hourly_rate = 30.00);


-- ────────────────────────────────────────────────────────────
-- 1b. MATERIALIZED VIEWS
-- ────────────────────────────────────────────────────────────

-- Job Intelligence: pre-computed profitability + activity signals
CREATE MATERIALIZED VIEW IF NOT EXISTS job_intelligence AS
SELECT
  j.id AS job_id,
  j.job_number,
  j.type AS job_type,
  j.status,
  j.client_name,
  j.site_suburb,
  j.created_at,
  j.accepted_at,
  j.completed_at,

  -- Quoted amount from pricing_json
  COALESCE((j.pricing_json->>'totalIncGST')::numeric, 0) AS quoted_amount,

  -- PO costs (materials)
  COALESCE(po_agg.po_total, 0) AS po_costs_total,
  COALESCE(po_agg.po_count, 0) AS po_count,

  -- Trade labour costs
  COALESCE(ti_agg.labour_total, 0) AS labour_costs_total,
  COALESCE(ti_agg.labour_hours, 0) AS total_trade_hours,
  COALESCE(ti_agg.invoice_count, 0) AS trade_invoice_count,

  -- Gross profit
  COALESCE((j.pricing_json->>'totalIncGST')::numeric, 0)
    - COALESCE(po_agg.po_total, 0)
    - COALESCE(ti_agg.labour_total, 0) AS gross_profit,

  -- Margin %
  CASE WHEN COALESCE((j.pricing_json->>'totalIncGST')::numeric, 0) > 0
    THEN ROUND(
      (COALESCE((j.pricing_json->>'totalIncGST')::numeric, 0)
        - COALESCE(po_agg.po_total, 0)
        - COALESCE(ti_agg.labour_total, 0))
      / (j.pricing_json->>'totalIncGST')::numeric * 100, 1)
    ELSE NULL
  END AS margin_pct,

  -- Event counts
  COALESCE(ev_agg.total_events, 0) AS total_events,
  COALESCE(ev_agg.notes_count, 0) AS notes_count,
  ev_agg.last_activity,

  -- Cycle time (days from created to completed)
  CASE WHEN j.completed_at IS NOT NULL
    THEN EXTRACT(DAY FROM j.completed_at - j.created_at)::int
    ELSE NULL
  END AS cycle_days,

  -- Days since last activity
  CASE WHEN ev_agg.last_activity IS NOT NULL
    THEN EXTRACT(DAY FROM NOW() - ev_agg.last_activity)::int
    ELSE EXTRACT(DAY FROM NOW() - j.created_at)::int
  END AS days_since_activity

FROM jobs j

LEFT JOIN LATERAL (
  SELECT
    SUM(COALESCE(po.total, 0)) AS po_total,
    COUNT(*) AS po_count
  FROM purchase_orders po
  WHERE po.job_id = j.id AND po.status != 'deleted'
) po_agg ON true

LEFT JOIN LATERAL (
  SELECT
    SUM(COALESCE(ti.total, 0)) AS labour_total,
    SUM(COALESCE(
      (SELECT SUM((li->>'hours')::numeric) FROM jsonb_array_elements(ti.line_items::jsonb) li
       WHERE (li->>'job_number') = j.job_number), 0
    )) AS labour_hours,
    COUNT(*) AS invoice_count
  FROM trade_invoices ti
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(ti.line_items::jsonb) li
    WHERE (li->>'job_number') = j.job_number
  )
) ti_agg ON true

LEFT JOIN LATERAL (
  SELECT
    COUNT(*) AS total_events,
    COUNT(*) FILTER (WHERE event_type = 'note') AS notes_count,
    MAX(created_at) AS last_activity
  FROM job_events
  WHERE job_id = j.id
) ev_agg ON true

WHERE j.legacy = false AND j.org_id = (SELECT id FROM organizations LIMIT 1);

-- Create index for fast refresh
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_intelligence_job_id ON job_intelligence(job_id);


-- AI Improvement Signals: acceptance rates, false positives, accuracy
CREATE MATERIALIZED VIEW IF NOT EXISTS ai_improvement_signals AS
SELECT
  tool_name,
  COUNT(*) AS total_calls,
  COUNT(*) FILTER (WHERE accepted = true) AS accepted_count,
  COUNT(*) FILTER (WHERE accepted = false) AS rejected_count,
  COUNT(*) FILTER (WHERE false_positive = true) AS false_positive_count,
  ROUND(COUNT(*) FILTER (WHERE accepted = true)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS acceptance_rate,
  ROUND(COUNT(*) FILTER (WHERE false_positive = true)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS false_positive_rate,
  AVG(EXTRACT(EPOCH FROM response_time))::numeric(8,2) AS avg_response_seconds,
  MAX(created_at) AS last_used,
  -- Weekly trend: acceptance rate in last 7 days
  ROUND(
    COUNT(*) FILTER (WHERE accepted = true AND created_at > NOW() - INTERVAL '7 days')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days'), 0) * 100, 1
  ) AS weekly_acceptance_rate
FROM ai_tool_calls
GROUP BY tool_name;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_signals_tool ON ai_improvement_signals(tool_name);


-- ────────────────────────────────────────────────────────────
-- 1c. FIX XERO BANK TRANSACTIONS TABLE
-- ────────────────────────────────────────────────────────────

-- Add missing columns that the Xero API provides
ALTER TABLE xero_bank_transactions ADD COLUMN IF NOT EXISTS account_name text;
ALTER TABLE xero_bank_transactions ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE xero_bank_transactions ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE xero_bank_transactions ADD COLUMN IF NOT EXISTS is_reconciled boolean DEFAULT true;
ALTER TABLE xero_bank_transactions ADD COLUMN IF NOT EXISTS line_items jsonb;
ALTER TABLE xero_bank_transactions ADD COLUMN IF NOT EXISTS sub_total numeric(12,2);
ALTER TABLE xero_bank_transactions ADD COLUMN IF NOT EXISTS total_tax numeric(12,2);


-- ────────────────────────────────────────────────────────────
-- 2a. DRAFT SMS — ai_proposed_actions table (if not exists)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_proposed_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) DEFAULT (SELECT id FROM organizations LIMIT 1),
  action_type text NOT NULL,  -- 'send_delivery_check_sms', 'send_followup_sms', etc.
  job_id uuid REFERENCES jobs(id),
  contact_id text,            -- GHL contact ID
  contact_name text,
  contact_phone text,
  drafted_message text,
  metadata jsonb DEFAULT '{}',
  status text DEFAULT 'pending',  -- pending, sent, dismissed, expired
  sent_at timestamptz,
  dismissed_at timestamptz,
  dismissed_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_proposed_actions_status ON ai_proposed_actions(status, action_type);
CREATE INDEX IF NOT EXISTS idx_proposed_actions_job ON ai_proposed_actions(job_id);


-- ────────────────────────────────────────────────────────────
-- pg_cron REFRESH SCHEDULES
-- ────────────────────────────────────────────────────────────

-- Run these if pg_cron is enabled:
-- SELECT cron.schedule('refresh-job-intelligence', '*/15 * * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY job_intelligence');
-- SELECT cron.schedule('refresh-ai-signals', '0 3 * * 1', 'REFRESH MATERIALIZED VIEW CONCURRENTLY ai_improvement_signals');


-- ══════════════════════════════════════════════════════════════
-- DONE — Verify with:
--   SELECT COUNT(*) FROM job_intelligence;
--   SELECT COUNT(*) FROM ai_improvement_signals;
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'xero_bank_transactions';
--   SELECT COUNT(*) FROM ai_proposed_actions;
-- ══════════════════════════════════════════════════════════════
