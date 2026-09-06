-- Opaque ownership token for an in-flight quote send claim.
-- Publish and revert must match this token so a stale reclaim cannot
-- be overwritten by the original worker.

alter table public.job_documents
  add column if not exists send_claim_token text;

comment on column public.job_documents.send_claim_token is
  'Opaque in-flight /send claim owner. Publish and revert match this token. Cleared on publication or revert. Not quote-pack publication.';
