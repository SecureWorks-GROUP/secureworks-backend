-- ════════════════════════════════════════════════════════════
-- Add billing lifecycle columns to purchase_orders
--
-- These columns are referenced by updatePO() and the Materials
-- tab UI but were never added to the schema. Closes the gap
-- between PO confirmation and supplier invoice tracking.
-- ════════════════════════════════════════════════════════════

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS invoice_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS xero_bill_id text;

-- Index for finding unpaid POs with received invoices
CREATE INDEX IF NOT EXISTS idx_po_billing
  ON purchase_orders(invoice_received_at, paid_at)
  WHERE invoice_received_at IS NOT NULL AND paid_at IS NULL;
