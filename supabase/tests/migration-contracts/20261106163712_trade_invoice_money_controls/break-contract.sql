-- Remove the no-week claim guard: the contract must notice.
DROP TRIGGER IF EXISTS trg_trade_invoice_lines_no_week_claim_guard ON public.trade_invoice_lines;
