-- After the down migration the ledger tables are gone and the stack is intact.
\set ON_ERROR_STOP on
DO $c$
BEGIN
 IF to_regclass('public.context_ledger_items') IS NOT NULL OR to_regclass('public.context_ledger_generations') IS NOT NULL
    OR to_regclass('public.context_ledger_transitions') IS NOT NULL OR to_regclass('public.context_ledger_settings') IS NOT NULL THEN
  RAISE EXCEPTION 'ledger rollback: tables remain';
 END IF;
 IF to_regclass('public.jobs') IS NULL OR to_regclass('public.context_extraction_runs') IS NULL THEN
  RAISE EXCEPTION 'ledger rollback: removed a table it does not own';
 END IF;
END $c$;
