-- Deliberately drop the write-once trigger: the contract must fail.
DROP TRIGGER quote_option_acceptances_write_once ON public.quote_option_acceptances;
