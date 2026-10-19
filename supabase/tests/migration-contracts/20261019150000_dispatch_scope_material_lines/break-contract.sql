-- Let the browser execute the scope material replace; the contract must then fail.
GRANT EXECUTE ON FUNCTION public.dispatch_replace_scope_material_lines(jsonb) TO authenticated;
