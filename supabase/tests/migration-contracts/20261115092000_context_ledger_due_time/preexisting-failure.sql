-- A due list that already carries some other statement_timeout was set by someone else: the
-- migration must refuse it rather than overwrite a limit it does not know.
ALTER FUNCTION public.context_ledger_due(integer) SET statement_timeout = '20s';
