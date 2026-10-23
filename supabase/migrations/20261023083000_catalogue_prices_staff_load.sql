-- Load approved supplier prices from a signed-in owner or admin session (Scope Engine catalogue, 23 Oct 2026).
--
-- catalogue_prices (20261022040000) could only be written with the service role key. This adds one door a
-- signed-in admin or owner can use from a staff page, so a load needs no key on anyone's machine.
--
-- Inserts only: a row whose (org_id, price_id) is already there is left exactly as it is, and nothing is
-- ever updated or deleted here. Rows always land in the caller's own org; any org_id in the input is ignored.
-- Every row must carry its ledger approval (approval_id, approved_until), as the table already requires.
-- No prices live in this repo: the rows come from the private ledger at load time.
--
-- Also adds two nullable columns, as the load file states them: `source` (where the price came from, e.g.
-- the supplier invoice and its date) and `source_class` (invoice, supplier list, equivalent product, WA
-- trade default). Office and job-system readers can tell an invoice price from an estimate; scoper screens
-- do not show them. Existing rows keep null.
--
-- Undo: drop function if exists public.catalogue_prices_staff_load(jsonb);
--       alter table public.catalogue_prices drop column if exists source_class;
--       alter table public.catalogue_prices drop column if exists source;

alter table public.catalogue_prices add column if not exists source text;
alter table public.catalogue_prices add column if not exists source_class text;

create or replace function public.catalogue_prices_staff_load(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.auth_org_id();
  v_received integer;
  v_inserted integer;
begin
  if auth.uid() is null or v_org is null then
    raise exception 'catalogue_prices_staff_load: sign in first' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = auth.uid() and lower(u.role) in ('admin', 'owner')
  ) then
    raise exception 'catalogue_prices_staff_load: only an admin or owner can load prices' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'catalogue_prices_staff_load: rows must be a JSON array' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received = 0 or v_received > 5000 then
    raise exception 'catalogue_prices_staff_load: between 1 and 5000 rows per load, got %', v_received using errcode = '22023';
  end if;

  with input as (
    select r.*
    from jsonb_to_recordset(p_rows) as r(
      price_id text, product_id text, offer_id text, supplier_id text, supplier_name text, description text,
      sku text, amount_ex_gst numeric, gst_rate numeric, currency text, basis text, length_mm numeric,
      min_qty numeric, max_qty numeric, valid_from date, approved_until date, approval_id text, entry_hash text,
      catalogue_revision text, ledger_count integer, ledger_hash text, load_id text, source text, source_class text
    )
  ), ins as (
    insert into public.catalogue_prices (
      org_id, price_id, product_id, offer_id, supplier_id, supplier_name, description, sku, amount_ex_gst,
      gst_rate, currency, basis, length_mm, min_qty, max_qty, valid_from, approved_until, approval_id,
      entry_hash, catalogue_revision, ledger_count, ledger_hash, load_id, source, source_class
    )
    select v_org, price_id, product_id, offer_id, supplier_id, supplier_name, description, sku, amount_ex_gst,
      gst_rate, currency, basis, length_mm, min_qty, max_qty, valid_from, approved_until, approval_id,
      entry_hash, catalogue_revision, ledger_count, ledger_hash, load_id, nullif(btrim(source), ''), nullif(btrim(source_class), '')
    from input
    on conflict (org_id, price_id) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return jsonb_build_object('received', v_received, 'inserted', v_inserted, 'already_present', v_received - v_inserted);
end;
$$;

revoke all on function public.catalogue_prices_staff_load(jsonb) from public, anon;
grant execute on function public.catalogue_prices_staff_load(jsonb) to authenticated;
