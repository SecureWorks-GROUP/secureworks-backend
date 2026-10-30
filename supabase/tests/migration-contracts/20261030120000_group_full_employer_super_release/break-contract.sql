-- Remove the release guard on invoice lines: rejecting a released share must then go through.
DROP TRIGGER trg_trade_invoice_lines_group_release_guard ON public.trade_invoice_lines;
