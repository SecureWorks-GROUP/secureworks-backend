-- Rollback for 20261113150000_quote_option_acceptances.sql.
-- Drops only the write-once trigger and its function. The record table is KEPT: it is
-- the only record of which options a customer took, and send-quote from before this
-- change never reads it. Drop it by hand only once its rows are copied elsewhere.
DROP TRIGGER IF EXISTS quote_option_acceptances_write_once ON public.quote_option_acceptances;
DROP FUNCTION IF EXISTS public.quote_option_acceptances_write_once();
