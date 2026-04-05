-- ============================================================
-- Work Order Invoicing — Link trade invoices to work orders
-- Enables lead trades to invoice against work order scope
-- IDEMPOTENT: safe to re-run
-- ============================================================

-- Add work_order_id to trade_invoices (optional — hourly invoices don't have one)
ALTER TABLE trade_invoices
  ADD COLUMN IF NOT EXISTS work_order_id uuid REFERENCES work_orders(id);

CREATE INDEX IF NOT EXISTS idx_trade_invoices_wo
  ON trade_invoices(work_order_id) WHERE work_order_id IS NOT NULL;

-- Add invoice_source to distinguish hourly vs work order invoices
ALTER TABLE trade_invoices
  ADD COLUMN IF NOT EXISTS invoice_source text DEFAULT 'hourly'
  CHECK (invoice_source IN ('hourly', 'work_order', 'per_metre', 'misc'));
