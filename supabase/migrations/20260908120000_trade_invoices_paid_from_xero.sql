-- 2026-09-08 (Marnin): trades see paid / owed on their own invoices.
-- xero_invoices already caches AmountPaid + FullyPaidOnDate per bill, and every
-- trade invoice pushed to Xero stores its bill id, but nothing joined them back:
-- 0 of 154 PAID trade bills were marked paid on trade_invoices. Land the three
-- columns, backfill from the cache, and let xero-sync keep them current.
ALTER TABLE trade_invoices
  ADD COLUMN IF NOT EXISTS paid_at date,
  ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS xero_bill_status text;

UPDATE trade_invoices ti
SET xero_bill_status = xi.status,
    amount_paid = COALESCE(xi.amount_paid, 0),
    paid_at = CASE WHEN xi.status = 'PAID' THEN COALESCE(xi.fully_paid_on, xi.updated_at::date) ELSE NULL END
FROM xero_invoices xi
WHERE xi.xero_invoice_id = ti.xero_bill_id
  AND ti.xero_bill_id IS NOT NULL;

-- Bills Xero says are PAID move to our 'paid' status (the state xero-sync was
-- always meant to write). Released / review states are left alone.
UPDATE trade_invoices
SET status = 'paid'
WHERE xero_bill_status = 'PAID'
  AND status IN ('pushed_to_xero', 'approved', 'acknowledged', 'pending_acknowledgment');

CREATE INDEX IF NOT EXISTS trade_invoices_user_week_end_idx ON trade_invoices (user_id, week_end DESC);
