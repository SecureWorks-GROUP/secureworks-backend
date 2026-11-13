-- Deliberately drop the line guard: labour past the maximum is let through and the contract must fail.
DROP TRIGGER job_labour_cap_guard_line ON public.trade_invoice_lines;
