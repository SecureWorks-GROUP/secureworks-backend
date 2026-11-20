-- Follow-up to 20261022040100 (#1117): RLS does not govern TRUNCATE, and the price ledger is
-- written only by the service role, so drop the remaining grants anon/authenticated never need.
revoke truncate on public.scope_tool_defaults from anon, authenticated;
revoke insert, update, delete, truncate on public.material_price_ledger from authenticated;
