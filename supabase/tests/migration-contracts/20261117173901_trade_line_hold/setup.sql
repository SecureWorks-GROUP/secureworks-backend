-- Registered invoice and office-review cases supply the legacy columns.
-- Mirror the existing production invoice-to-lines lookup index.
CREATE INDEX IF NOT EXISTS idx_inv_lines_invoice
  ON public.trade_invoice_lines (trade_invoice_id);
