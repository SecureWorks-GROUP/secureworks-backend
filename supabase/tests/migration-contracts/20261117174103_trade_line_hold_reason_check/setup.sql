-- Reproduce the existing column before the CHECK is added.
ALTER TABLE public.trade_invoice_lines ADD COLUMN IF NOT EXISTS hold_reason text;
