-- Prerequisites for 20261019150000_dispatch_scope_material_lines. Earlier
-- registered cases already create jobs, suppliers, purchase_orders,
-- job_material_lines, dispatch_scope_order_lines and the API roles.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'public.jobs', 'public.suppliers', 'public.purchase_orders',
  'public.job_material_lines', 'public.job_material_suppliers',
  'public.dispatch_scope_order_lines'
 ] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'scope material lines setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
   RAISE EXCEPTION 'scope material lines setup: role % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
