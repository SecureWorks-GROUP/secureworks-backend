-- ============================================================
-- Migration: email_events — unified transactional email log
-- All email types (PO, quote, invoice, reminder, follow-up) write here.
-- Resend webhooks update delivery/open/bounce status.
-- ============================================================

create table if not exists email_events (
  id                uuid primary key default gen_random_uuid(),
  email_type        text not null,              -- 'po', 'quote', 'invoice', 'reminder', 'follow_up', 'receipt', 'notification'
  entity_type       text,                       -- 'purchase_order', 'job', 'invoice', 'job_contact'
  entity_id         uuid,                       -- polymorphic link to the relevant record
  job_id            uuid references jobs(id) on delete set null,
  recipient         text not null,
  sender            text not null,
  subject           text,
  resend_message_id text,                       -- Resend's ID for webhook matching
  status            text not null default 'queued',  -- queued, sent, delivered, opened, bounced, failed, complained
  sent_at           timestamptz,
  delivered_at      timestamptz,
  opened_at         timestamptz,
  opened_count      int default 0,
  last_opened_at    timestamptz,
  clicked_at        timestamptz,
  bounced_at        timestamptz,
  failed_at         timestamptz,
  failure_reason    text,
  metadata          jsonb default '{}'::jsonb,   -- template name, PO number, neighbour contact, etc.
  created_at        timestamptz default now()
);

create index idx_email_events_job on email_events(job_id);
create index idx_email_events_entity on email_events(entity_type, entity_id);
create index idx_email_events_resend_id on email_events(resend_message_id);
create index idx_email_events_status on email_events(status);
create index idx_email_events_type on email_events(email_type);

alter table email_events enable row level security;

-- Service role full access (edge functions use service role)
create policy "Service role manages email_events"
  on email_events for all
  using (auth.role() = 'service_role');

-- Authenticated users can read (for dashboard display)
create policy "Authenticated users view email_events"
  on email_events for select
  using (auth.role() = 'authenticated');
