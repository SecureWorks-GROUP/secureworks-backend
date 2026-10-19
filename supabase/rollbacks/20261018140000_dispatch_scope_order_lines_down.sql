-- Down for 20261018140000_dispatch_scope_order_lines. Drops the replace
-- function and the scope order lines table, and nothing else: jobs remain.
-- Roll ops-api back first: the deployed dispatch_scope_order_lines read and
-- dispatch_scope_order_import write name this table and this function.
DROP FUNCTION IF EXISTS public.dispatch_replace_scope_order_lines(jsonb);
DROP TABLE IF EXISTS public.dispatch_scope_order_lines;
