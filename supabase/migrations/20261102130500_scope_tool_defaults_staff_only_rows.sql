-- Scope tool defaults: staff-only rows (Scope Engine SE-54, 2 Nov 2026).
--
-- The margin target and floor and the sales commission rates are internal commercial settings the new
-- scoping tools read with the staff sign-in. They go in rows with category 'staff_only', which only
-- signed-in staff in the cost roles of their own org can read (the same roles as catalogue_prices).
--
-- Every other row stays readable as before, signed in or out: the old fence page (fence-designer, repo
-- root) reads the fence cost rows with the public key, and keeps pricing exactly as today.
--
-- No row and no figure is written here; the rows are loaded separately, after this rule is live.
-- Undo: drop both policies below and create "anon_read_scope_defaults" again as in
-- 20260320000006 (for select using (true)), after deleting the 'staff_only' rows.

drop policy if exists "anon_read_scope_defaults" on public.scope_tool_defaults;

drop policy if exists scope_tool_defaults_read_open on public.scope_tool_defaults;
create policy scope_tool_defaults_read_open on public.scope_tool_defaults
  for select
  using (category <> 'staff_only');

drop policy if exists scope_tool_defaults_read_staff_only on public.scope_tool_defaults;
create policy scope_tool_defaults_read_staff_only on public.scope_tool_defaults
  for select to authenticated
  using (
    category = 'staff_only'
    and org_id = public.auth_org_id()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid() and lower(u.role) in ('admin', 'owner', 'ops_manager', 'estimator')
    )
  );
