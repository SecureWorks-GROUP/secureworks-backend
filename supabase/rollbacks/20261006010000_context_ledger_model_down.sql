-- Rollback of 20261006010000_context_ledger_model: drops the ledger tables.
-- Nothing outside the ledger reads them; the fact store is untouched.
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS public.context_ledger_transitions;
DROP TABLE IF EXISTS public.context_ledger_items;
DROP TABLE IF EXISTS public.context_ledger_generations;
DROP TABLE IF EXISTS public.context_ledger_settings;
