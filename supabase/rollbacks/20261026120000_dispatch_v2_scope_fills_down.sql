-- Down for 20261026120000_dispatch_v2_scope_fills. Roll ops-api back first:
-- dispatch_v2_materials and dispatch_v2_suggest_draft read and write this
-- table. Only the fill records go; the lines and boxes the fills made stay.
DROP TABLE IF EXISTS public.dispatch_v2_scope_fills;
