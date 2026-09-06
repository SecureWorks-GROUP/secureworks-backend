-- Invoice-scoped email send claim (TRD6-REV13-004).
-- Operational mail lease, not the Xero money mirror. Exclusive claim,
-- stale reclaim with token fencing, heartbeat via send_claimed_at, and a
-- first-claim Resend idempotency key that survives reclaim.

create table if not exists public.invoice_email_send_claims (
  xero_invoice_id text primary key,
  job_id uuid not null,
  send_claimed_at timestamptz,
  send_claim_token text,
  send_resend_idempotency_key text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.invoice_email_send_claims is
  'In-flight and published branded invoice email sends. Token-fenced claim. Not xero_invoices money.';

comment on column public.invoice_email_send_claims.send_claimed_at is
  'In-flight send-invoice lease. Heartbeat refreshes this stamp. Stale claims may be reclaimed.';

comment on column public.invoice_email_send_claims.send_claim_token is
  'Opaque in-flight owner. Publish, revert, and heartbeat match this token.';

comment on column public.invoice_email_send_claims.send_resend_idempotency_key is
  'First-claim Resend Idempotency-Key. Survives reclaim. Cleared on revert.';

comment on column public.invoice_email_send_claims.sent_at is
  'Publication after Resend success. Concurrent retries return already_sent.';

alter table public.invoice_email_send_claims enable row level security;

revoke all on table public.invoice_email_send_claims from public, anon, authenticated;

drop policy if exists service_role_all_invoice_email_send_claims
  on public.invoice_email_send_claims;

create policy service_role_all_invoice_email_send_claims
  on public.invoice_email_send_claims
  for all
  to service_role
  using (true)
  with check (true);
