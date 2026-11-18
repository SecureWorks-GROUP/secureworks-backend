-- Historical contract stacks may omit the existing Xero mirror column.
ALTER TABLE public.trade_invoices ADD COLUMN IF NOT EXISTS xero_adjustments_ex numeric;
