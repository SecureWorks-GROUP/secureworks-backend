-- Down for 20261106163712_trade_invoice_money_controls.
-- Drops the no-week claim guard, the extras rate rules, the event record and
-- the unique invoice number index. Invoices and lines are untouched.
DROP TRIGGER IF EXISTS trg_trade_invoice_lines_no_week_claim_guard ON public.trade_invoice_lines;
DROP FUNCTION IF EXISTS public.trade_invoice_lines_no_week_claim_guard();
DROP FUNCTION IF EXISTS public.trade_invoice_no_week_claim_key(uuid, text);
DROP TABLE IF EXISTS public.trade_invoice_extra_rate_rules;
DROP TABLE IF EXISTS public.trade_invoice_events;
DROP FUNCTION IF EXISTS public.trade_invoice_events_append_only();
DROP INDEX IF EXISTS public.trade_invoices_invoice_number_key;
