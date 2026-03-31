-- ============================================================
-- Migration: Bank balances, aged payables, bank transactions
-- Run in Supabase SQL Editor
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- XERO BANK BALANCES — daily snapshot of cash position
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xero_bank_balances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  account_id      text NOT NULL,
  account_name    text NOT NULL,
  account_code    text,
  currency        text DEFAULT 'AUD',
  balance         numeric(12,2) NOT NULL,
  synced_at       timestamptz NOT NULL,
  created_at      timestamptz DEFAULT now(),
  UNIQUE(org_id, account_id, synced_at::date)
);

CREATE INDEX idx_bank_balances_org ON xero_bank_balances(org_id);
CREATE INDEX idx_bank_balances_date ON xero_bank_balances(synced_at);

ALTER TABLE xero_bank_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view balances" ON xero_bank_balances FOR SELECT USING (true);
CREATE POLICY "Service role manages" ON xero_bank_balances FOR ALL USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- XERO AGED PAYABLES — what you owe suppliers (bills due)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xero_aged_payables (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  contact_name    text NOT NULL,
  contact_id      text,
  amount_due      numeric(12,2) NOT NULL,
  age_bucket      text NOT NULL,  -- 'current', '1-30', '31-60', '61-90', '90+'
  invoice_number  text,
  due_date        date,
  synced_at       timestamptz NOT NULL,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_aged_payables_org ON xero_aged_payables(org_id);
CREATE INDEX idx_aged_payables_synced ON xero_aged_payables(synced_at);

ALTER TABLE xero_aged_payables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view payables" ON xero_aged_payables FOR SELECT USING (true);
CREATE POLICY "Service role manages" ON xero_aged_payables FOR ALL USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- XERO BANK TRANSACTIONS — reconciled transactions (90-day window)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xero_bank_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  xero_txn_id     text NOT NULL,
  account_id      text NOT NULL,
  account_name    text,
  txn_date        date NOT NULL,
  txn_type        text,  -- 'RECEIVE', 'SPEND', 'TRANSFER'
  contact_name    text,
  contact_id      text,
  reference       text,
  description     text,
  amount          numeric(12,2) NOT NULL,
  is_reconciled   boolean DEFAULT true,
  synced_at       timestamptz NOT NULL,
  created_at      timestamptz DEFAULT now(),
  UNIQUE(org_id, xero_txn_id)
);

CREATE INDEX idx_bank_txns_org ON xero_bank_transactions(org_id);
CREATE INDEX idx_bank_txns_date ON xero_bank_transactions(txn_date);
CREATE INDEX idx_bank_txns_contact ON xero_bank_transactions(contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE xero_bank_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view transactions" ON xero_bank_transactions FOR SELECT USING (true);
CREATE POLICY "Service role manages" ON xero_bank_transactions FOR ALL USING (auth.role() = 'service_role');
