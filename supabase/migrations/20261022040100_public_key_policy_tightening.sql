-- Public-key policy tightening (#1117): the anon key can no longer write scope defaults
-- or read the material price ledger.

-- scope_tool_defaults: only the service role writes.
drop policy if exists "service_role_full_access" on public.scope_tool_defaults;
create policy "service_role_full_access" on public.scope_tool_defaults
  for all to service_role using (true) with check (true);
revoke insert, update, delete on public.scope_tool_defaults from anon, authenticated;

-- material_price_ledger: signed-in staff of the same organisation read; the service role writes.
drop policy if exists "users_read_ledger" on public.material_price_ledger;
create policy "users_read_ledger" on public.material_price_ledger
  for select to authenticated using (org_id = public.auth_org_id());
revoke all on public.material_price_ledger from anon;
