-- Let any event go without its invoice: the contract must notice.
ALTER TABLE public.trade_invoice_events DROP CONSTRAINT IF EXISTS trade_invoice_events_invoice_required;
