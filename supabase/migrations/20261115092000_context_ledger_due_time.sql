-- Context AI notes: the due list gets time to answer (15 Nov 2026).
--
-- Why: the notes worker asks context_ledger_due which jobs to read. The service role's statement
-- limit is 30 s and the worker's own is 28 s. On 15 Nov 2026, with every live job back in the
-- reader's list (920 live jobs, 1,014 judged, 110 due), the call took 21.7 s and 27.1 s on
-- production, and failed once at 09:06Z (context_ledger_due_failed). The same cliff stopped the
-- reader on 2 Nov (45 s) and 3 Nov (20 to 23 s against a 20 s client limit). Measured parts on
-- 15 Nov: the judge over the live jobs 9.5 s, the unread-row ordering of the due jobs 4.3 s, the
-- two lead-rule reads 0.6 s; the rest is the same work under the reader's own load.
--
-- What: the function carries statement_timeout = 45s. PostgREST hoists a function's
-- statement_timeout onto the request's transaction (the scorecard reads rely on the same thing),
-- so a call through the API may run 45 s instead of the role's 30 s. The body, the comment, the
-- rows, their order and the grants do not change. The worker waits 43 s for this one call
-- (secureworks-jarvis); every other call keeps its 28 s. Either release order is safe: until both
-- are live the call is cut at 28 or 30 s as it is today.
--
-- A later CREATE OR REPLACE of context_ledger_due must carry SET statement_timeout = '45s' too,
-- or it drops this setting without a word.
-- The rollbacks of 20261102210000 and earlier replace the function and so drop it too, and
-- 20261104175000's rollback pins the whole definition and refuses while it is set: roll this
-- back first, and apply it again after.
-- Rollback: supabase/rollbacks/20261115092000_context_ledger_due_time_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE cfg text[];
BEGIN
  IF to_regprocedure('public.context_ledger_due(integer)') IS NULL THEN
    RAISE EXCEPTION 'context_ledger_due_time_preimage_mismatch: context_ledger_due(integer) is missing';
  END IF;
  SELECT p.proconfig INTO cfg FROM pg_proc p WHERE p.oid = 'public.context_ledger_due(integer)'::regprocedure;
  -- Only the two states this migration knows: no statement_timeout yet, or ours already.
  IF EXISTS (SELECT 1 FROM unnest(coalesce(cfg, ARRAY[]::text[])) c
             WHERE c LIKE 'statement_timeout=%' AND c <> 'statement_timeout=45s') THEN
    RAISE EXCEPTION 'context_ledger_due_time_preimage_mismatch: context_ledger_due already carries another statement_timeout (%)', cfg;
  END IF;
END
$guard$;

ALTER FUNCTION public.context_ledger_due(integer) SET statement_timeout = '45s';
