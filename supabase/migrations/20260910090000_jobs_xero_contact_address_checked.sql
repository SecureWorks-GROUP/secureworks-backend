-- 2026-09-10: xero-sync sweeps customer contacts our automation created without
-- a postal address (Xero prints POBOX on invoices). Stamp per job once its
-- Xero contact has been read back and fixed/verified so the sweep never re-reads it.
alter table public.jobs add column if not exists xero_contact_address_checked_at timestamptz;
create index if not exists jobs_xero_contact_address_sweep_idx
  on public.jobs (created_at desc)
  where xero_contact_id is not null and site_address is not null and xero_contact_address_checked_at is null;
