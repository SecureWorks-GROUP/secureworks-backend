-- Registered invoice and office-review cases supply the legacy columns.
-- The separately released reason guard owns this constraint before our deploy.
\ir ../../../migrations/20261117174103_trade_line_hold_reason_check.sql
-- Mirror the existing production invoice-to-lines lookup index.
CREATE INDEX IF NOT EXISTS idx_inv_lines_invoice
  ON public.trade_invoice_lines (trade_invoice_id);
