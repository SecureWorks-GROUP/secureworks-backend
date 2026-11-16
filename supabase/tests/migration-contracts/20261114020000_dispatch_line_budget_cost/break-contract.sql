-- Deliberately drop the append-only guard: the contract must fail.
DROP TRIGGER dispatch_line_cost_reasons_write_once ON public.dispatch_line_cost_reasons;
