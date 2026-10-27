-- Provisional supplier prices on catalogue_prices (Scope Engine T63, 23 Oct 2026).
--
-- The owner said to load the provisional ledger prices too, marked provisional: staff cost
-- screens show them as "to confirm" and customer documents never use them. A provisional
-- row has no approval yet, so approval_id and approved_until may be null on that row only.
--
-- Schema only. Every existing row takes the default 'approved' and keeps its approval;
-- no row is written, changed or removed. Rows are still written only by scope-engine-v2
-- shared/scripts/staff-prices.ts with the service role key. Read access is unchanged.
-- Mirrors scope-engine-v2 shared/catalogue/staff-prices.sql.
--
-- Undo (only while no provisional row exists):
--   alter table public.catalogue_prices drop constraint if exists catalogue_prices_approved_has_approval;
--   alter table public.catalogue_prices alter column approval_id set not null;
--   alter table public.catalogue_prices alter column approved_until set not null;
--   alter table public.catalogue_prices drop constraint if exists catalogue_prices_status;
--   alter table public.catalogue_prices drop column if exists status;

alter table public.catalogue_prices add column if not exists status text not null default 'approved';

alter table public.catalogue_prices drop constraint if exists catalogue_prices_status;
alter table public.catalogue_prices add constraint catalogue_prices_status
  check (status in ('approved', 'provisional'));

alter table public.catalogue_prices alter column approval_id drop not null;
alter table public.catalogue_prices alter column approved_until drop not null;

alter table public.catalogue_prices drop constraint if exists catalogue_prices_approved_has_approval;
alter table public.catalogue_prices add constraint catalogue_prices_approved_has_approval
  check (status = 'provisional' or (approval_id is not null and approved_until is not null));
