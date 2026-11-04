-- Undo 20261103140000_trade_invoice_xero_adjustments: the crew bill's Xero
-- total and the office's changes are no longer recorded. Deploy the ops-api
-- and xero-sync from before that change first; they select these columns.
ALTER TABLE public.trade_invoices
  DROP CONSTRAINT IF EXISTS trade_invoices_xero_adjustments_read_together;
DROP FUNCTION IF EXISTS public.trade_invoice_xero_adjustments_tie(numeric, jsonb);
ALTER TABLE public.trade_invoices
  DROP COLUMN IF EXISTS xero_adjustment_lines,
  DROP COLUMN IF EXISTS xero_adjustments_ex,
  DROP COLUMN IF EXISTS xero_bill_total;
