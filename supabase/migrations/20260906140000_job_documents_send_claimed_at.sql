-- In-flight lock for send-quote /send. Not a client-send publication.
-- Quote-pack eligibility reads sent_to_client + sent_at after Resend, never
-- this claim stamp.

alter table public.job_documents
  add column if not exists send_claimed_at timestamptz;

comment on column public.job_documents.send_claimed_at is
  'In-flight /send claim. Cleared on Resend failure. Not quote-pack publication.';
