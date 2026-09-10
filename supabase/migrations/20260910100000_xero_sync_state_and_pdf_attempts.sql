-- 2026-09-10: Xero sync hardening.
-- 1. An explicit incremental cursor for sync_invoices. The old cursor was
--    MAX(xero_invoices.updated_at), which every local write (and the table
--    trigger) pushes forward, so a failed or in-flight run lost its window.
create table if not exists public.xero_sync_state (
  key text primary key,
  cursor_at timestamptz,
  note text,
  updated_at timestamptz not null default now()
);
alter table public.xero_sync_state enable row level security;

-- 2. The trade bill PDF sweep retried the same un-attachable bills every
--    15 minutes forever (18 legacy bills have no money split). Count attempts.
alter table public.trade_invoices
  add column if not exists pdf_backfill_attempts integer not null default 0,
  add column if not exists pdf_backfill_last_error text;
