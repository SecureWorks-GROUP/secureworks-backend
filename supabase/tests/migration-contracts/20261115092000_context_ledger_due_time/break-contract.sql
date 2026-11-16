-- Take the setting off again, as a later CREATE OR REPLACE without the SET clause would.
ALTER FUNCTION public.context_ledger_due(integer) RESET statement_timeout;
