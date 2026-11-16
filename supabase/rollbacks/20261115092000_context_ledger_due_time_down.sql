-- Rollback of 20261115092000_context_ledger_due_time.sql: the due list goes back to the role's own
-- statement limit (30 s for the service role). The body, comment and grants were never changed.
-- Ship the worker's 28 s limit for this call first, or it waits 43 s for an answer the database
-- cuts at 30 s (harmless: the call fails as it did before).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE cfg text[];
BEGIN
  IF to_regprocedure('public.context_ledger_due(integer)') IS NULL THEN
    RAISE EXCEPTION 'context_ledger_due_time_down_preimage_mismatch: context_ledger_due(integer) is missing';
  END IF;
  SELECT p.proconfig INTO cfg FROM pg_proc p WHERE p.oid = 'public.context_ledger_due(integer)'::regprocedure;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(cfg, ARRAY[]::text[])) c
             WHERE c LIKE 'statement_timeout=%' AND c <> 'statement_timeout=45s') THEN
    RAISE EXCEPTION 'context_ledger_due_time_down_preimage_mismatch: context_ledger_due carries a statement_timeout this rollback did not set (%)', cfg;
  END IF;
END
$guard$;

ALTER FUNCTION public.context_ledger_due(integer) RESET statement_timeout;
