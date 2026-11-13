-- Deliberately switch the line guard off (it stays a deferred constraint trigger, so the structural check
-- passes): labour past the maximum is let through and the contract must fail.
ALTER TABLE public.trade_invoice_lines DISABLE TRIGGER job_labour_cap_guard_line;
