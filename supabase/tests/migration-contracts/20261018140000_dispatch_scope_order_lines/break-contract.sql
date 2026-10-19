-- Let the browser read the scope order lines; the contract must then fail on the privilege check.
GRANT SELECT ON TABLE public.dispatch_scope_order_lines TO authenticated;
