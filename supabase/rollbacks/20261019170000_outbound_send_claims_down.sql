-- Rollback for 20261019170000_outbound_send_claims.sql.
--
-- Refuses while any attempt is unresolved (sending or outcome_unknown): those
-- rows are the only record that a send may already have reached a client, and
-- dropping the doors that release them would strand the hold. Settle or
-- reconcile them first.
--
-- Otherwise drops the claim functions only. Both tables, their rows, the event
-- trail and the guard triggers (append-only, no truncate) are kept, so the
-- record of every past send survives the rollback and a later forward re-apply
-- picks it up. The ops-api and send-outlook-email that ship with the claims
-- refuse every send when the claim functions are missing (a send never goes out
-- unclaimed), so roll the functions back first and this migration after.
-- One statement, so the guard and the drops commit or fail together.
-- Re-running it is a no-op.

DO $$
BEGIN
  IF to_regclass('public.outbound_send_claims') IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.outbound_send_claims WHERE state IN ('sending', 'outcome_unknown')) THEN
    RAISE EXCEPTION 'outbound send claims unresolved: settle or reconcile every sending and outcome_unknown attempt before rolling back 20261019170000';
  END IF;
  DROP FUNCTION IF EXISTS public.reconcile_outbound_send(text, text, text, text, timestamptz, text);
  DROP FUNCTION IF EXISTS public.settle_outbound_send(text, text, jsonb, text, text);
  DROP FUNCTION IF EXISTS public.settle_outbound_send(text, text, jsonb, text);
  DROP FUNCTION IF EXISTS public.settle_outbound_send(text, text, jsonb);
  DROP FUNCTION IF EXISTS public.confirm_outbound_dispatch(text, text);
  DROP FUNCTION IF EXISTS public.extend_outbound_send_claim(text, text[], text, text, jsonb);
  DROP FUNCTION IF EXISTS public.extend_outbound_send_claim(text, text[], text, jsonb);
  DROP FUNCTION IF EXISTS public.claim_outbound_send(text[], text, text, jsonb, integer);
  DROP FUNCTION IF EXISTS public.outbound_send_claim_insert(text[], text, text, jsonb, timestamptz, uuid, text, text);
  DROP FUNCTION IF EXISTS public.outbound_send_claim_insert(text[], text, text, jsonb, integer, text);
  DROP FUNCTION IF EXISTS public.outbound_send_claim_keys(text[]);
  DROP FUNCTION IF EXISTS public.outbound_send_claim_lock(text, text);
  DROP FUNCTION IF EXISTS public.read_outbound_send_holds(text[]);
END $$;
