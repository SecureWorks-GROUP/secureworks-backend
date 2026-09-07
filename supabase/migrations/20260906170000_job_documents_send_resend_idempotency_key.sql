-- Durable Resend idempotency key for quote /send claims (TRD6-REV13-003).
-- Set on first exclusive claim. Reclaim rotates send_claim_token but keeps
-- this key so a delayed original worker and a reclaimer cannot both dispatch.

alter table public.job_documents
  add column if not exists send_resend_idempotency_key text;

comment on column public.job_documents.send_resend_idempotency_key is
  'First-claim Resend Idempotency-Key. Survives reclaim. Cleared on revert. Not quote-pack publication.';
