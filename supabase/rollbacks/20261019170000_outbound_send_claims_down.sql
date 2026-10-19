-- Rollback for 20261019170000_outbound_send_claims.sql.
--
-- Drops the send-claim functions and both tables. The claim rows and their
-- event trail go with them, so read or export outbound_send_claim_events first
-- if any unresolved hold must be kept. The ops-api and send-outlook-email that
-- ship with the claims refuse every send when the claim functions are missing
-- (a send never goes out unclaimed), so roll the functions back first and this
-- migration after. Re-running it is a no-op.

DROP FUNCTION IF EXISTS public.reconcile_outbound_send(text, text, text, text, timestamptz, text);
DROP FUNCTION IF EXISTS public.settle_outbound_send(text, text, jsonb);
DROP FUNCTION IF EXISTS public.extend_outbound_send_claim(text, text[], text, jsonb);
DROP FUNCTION IF EXISTS public.claim_outbound_send(text[], text, text, jsonb, integer);
DROP FUNCTION IF EXISTS public.outbound_send_claim_insert(text[], text, text, jsonb, integer, text);
DROP FUNCTION IF EXISTS public.read_outbound_send_holds(text[]);
DROP TABLE IF EXISTS public.outbound_send_claim_events;
DROP FUNCTION IF EXISTS public.outbound_send_claim_events_append_only();
DROP TABLE IF EXISTS public.outbound_send_claims;
