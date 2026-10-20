-- Prerequisites for 20261020150000_dispatch_line_receipts. Earlier registered cases create
-- public.jobs, public.users, public.suppliers, public.purchase_orders, the three slice 4 Dispatch
-- tables (job_material_lines among them) and the API roles. Nothing is added here.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs', 'public.users', 'public.suppliers', 'public.purchase_orders',
                          'public.job_material_suppliers', 'public.job_material_lines'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'dispatch line receipts setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
   RAISE EXCEPTION 'dispatch line receipts setup: role % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
