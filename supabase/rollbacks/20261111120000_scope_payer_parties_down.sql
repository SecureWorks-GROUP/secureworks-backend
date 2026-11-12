-- Undo 20261111120000: drop the payer registration function. Party rows it
-- wrote stay: they are ordinary job_contacts rows owned by upsert_job_party,
-- with their job_party_events receipts (actor scope_payer_parties). A payer
-- it soft-removed stays removed until the party writer restores it.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.register_scope_payer_parties(uuid, uuid, uuid);
