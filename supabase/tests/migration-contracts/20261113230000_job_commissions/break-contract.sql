-- Deliberately drop the cap on invoice lines: the contract must fail.
DROP TRIGGER trade_invoice_lines_commission_cap ON public.trade_invoice_lines;
