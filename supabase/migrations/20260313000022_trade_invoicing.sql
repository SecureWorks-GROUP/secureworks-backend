-- ════════════════════════════════════════════════════════════
-- Trade Invoicing — rates, invoice records, user links
-- ════════════════════════════════════════════════════════════

-- 1. Trade hourly rates (supports rate history via date ranges)
CREATE TABLE IF NOT EXISTS trade_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  user_id        uuid NOT NULL REFERENCES users(id),
  hourly_rate    numeric(8,2) NOT NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz DEFAULT now(),
  UNIQUE(org_id, user_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_trade_rates_user ON trade_rates(user_id);

-- 2. Trade invoices — local record of what was pushed to Xero
CREATE TABLE IF NOT EXISTS trade_invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id),
  week_ending      date NOT NULL,
  line_items       jsonb NOT NULL DEFAULT '[]',
  subtotal         numeric(12,2) DEFAULT 0,
  gst              numeric(12,2) DEFAULT 0,
  total            numeric(12,2) DEFAULT 0,
  notes            text,
  xero_invoice_id  text,
  xero_bill_number text,
  status           text DEFAULT 'pushed' CHECK (status IN ('pushed', 'failed')),
  created_at       timestamptz DEFAULT now(),
  UNIQUE(org_id, user_id, week_ending)
);

-- 3. Link users to Xero supplier contacts
ALTER TABLE users ADD COLUMN IF NOT EXISTS xero_contact_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS abn text;
