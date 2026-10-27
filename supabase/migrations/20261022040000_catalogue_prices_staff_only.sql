-- Approved supplier prices for signed-in staff tools (Scope Engine catalogue, 22 Oct 2026).
--
-- One row per ledger price approved on the day it was loaded. Rows are written only by
-- scope-engine-v2 shared/scripts/staff-prices.ts with the service role key, from the private ledger.
-- Signed-in staff in the cost roles of their own org can read them; anon and other roles cannot.
-- No prices live in this repo. Amounts are ex GST, with the GST rate kept beside them.

create table if not exists public.catalogue_prices (
  org_id            uuid        not null,
  price_id          text        not null,               -- the ledger's price id
  product_id        text        not null,               -- catalogue product id (catalogue/suppliers/catalogue.json)
  offer_id          text        not null,
  supplier_id       text        not null,
  supplier_name     text        not null,
  description       text        not null,
  sku               text,                               -- supplier code, null when the document prints none
  amount_ex_gst     numeric     not null check (amount_ex_gst >= 0),
  gst_rate          numeric,
  currency          text        not null,
  basis             text        not null,               -- order-unit, each, m, m2, m3, per-100
  length_mm         numeric,
  min_qty           numeric,
  max_qty           numeric,
  valid_from        date        not null,               -- the document date
  approved_until    date        not null,               -- valid_from plus the approval's age limit
  approval_id       text        not null,
  entry_hash        text        not null,               -- the ledger entry the approval names
  catalogue_revision text       not null,
  ledger_count      integer     not null,
  ledger_hash       text        not null,
  load_id           text        not null,               -- one id per load; rows from older loads are removed
  loaded_at         timestamptz not null default now(),
  primary key (org_id, price_id)
);

create index if not exists catalogue_prices_product on public.catalogue_prices (org_id, product_id, offer_id);

alter table public.catalogue_prices enable row level security;

drop policy if exists catalogue_prices_staff_read on public.catalogue_prices;
create policy catalogue_prices_staff_read on public.catalogue_prices
  for select to authenticated
  using (
    org_id = public.auth_org_id()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid() and lower(u.role) in ('admin', 'owner', 'ops_manager', 'estimator')
    )
  );

drop policy if exists catalogue_prices_service_write on public.catalogue_prices;
create policy catalogue_prices_service_write on public.catalogue_prices
  for all to service_role
  using (true) with check (true);

revoke all on public.catalogue_prices from anon;
grant select on public.catalogue_prices to authenticated;
revoke insert, update, delete, truncate on public.catalogue_prices from authenticated;
