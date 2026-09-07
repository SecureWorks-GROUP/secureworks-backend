-- Recipient-group send record for send-runs (TRD6-18-003).
-- Operational mail state, not money. Stores the first grouped Resend
-- Idempotency-Key for a job + normalized recipient + original document
-- set so a retry of leftovers after partial publication reuses the same
-- provider key. Partial group publish stays allowed; this is not a lease.

create table if not exists public.quote_group_email_send_records (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  recipient_email text not null,
  document_ids uuid[] not null,
  document_set_key text not null,
  send_resend_idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quote_group_email_send_records_recipient_email_check
    check (recipient_email <> ''),
  constraint quote_group_email_send_records_document_ids_check
    check (cardinality(document_ids) > 0),
  constraint quote_group_email_send_records_document_set_key_check
    check (document_set_key <> ''),
  constraint quote_group_email_send_records_send_key_check
    check (send_resend_idempotency_key <> ''),
  constraint quote_group_email_send_records_job_recipient_set_key
    unique (job_id, recipient_email, document_set_key)
);

comment on table public.quote_group_email_send_records is
  'First send-runs grouped Resend Idempotency-Key per job, recipient, and original document set. Not a send lease.';

comment on column public.quote_group_email_send_records.recipient_email is
  'Trim + lowercase inbox key (quoteSendRecipientKey).';

comment on column public.quote_group_email_send_records.document_ids is
  'Original grouped document ids, unique and sorted. Leftover retries are subsets.';

comment on column public.quote_group_email_send_records.document_set_key is
  'Canonical sorted id list for the unique original set.';

comment on column public.quote_group_email_send_records.send_resend_idempotency_key is
  'First-group Resend Idempotency-Key. Survives partial publication.';

create index if not exists quote_group_email_send_records_job_recipient_idx
  on public.quote_group_email_send_records (job_id, recipient_email);

alter table public.quote_group_email_send_records enable row level security;

revoke all on table public.quote_group_email_send_records from public, anon, authenticated;

drop policy if exists service_role_all_quote_group_email_send_records
  on public.quote_group_email_send_records;

create policy service_role_all_quote_group_email_send_records
  on public.quote_group_email_send_records
  for all
  to service_role
  using (true)
  with check (true);
