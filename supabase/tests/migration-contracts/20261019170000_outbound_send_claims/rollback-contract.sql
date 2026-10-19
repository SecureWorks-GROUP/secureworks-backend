-- The runner has just run the down migration against the forward stack.
DO $$
BEGIN
  IF to_regclass('public.outbound_send_claims') IS NOT NULL
     OR to_regclass('public.outbound_send_claim_events') IS NOT NULL
     OR to_regprocedure('public.claim_outbound_send(text[], text, text, jsonb, integer)') IS NOT NULL
     OR to_regprocedure('public.reconcile_outbound_send(text, text, text, text, timestamptz, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a claim table or function is still there';
  END IF;
END $$;
-- Re-running the rollback is a no-op, and the forward migration applies again.
\ir ../../../rollbacks/20261019170000_outbound_send_claims_down.sql
BEGIN;
\ir ../../../migrations/20261019170000_outbound_send_claims.sql
DO $$
BEGIN
  IF to_regprocedure('public.claim_outbound_send(text[], text, text, jsonb, integer)') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
