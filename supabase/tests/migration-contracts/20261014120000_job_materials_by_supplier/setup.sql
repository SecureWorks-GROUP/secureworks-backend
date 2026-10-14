-- Prerequisites for 20261014120000_job_materials_by_supplier. Earlier registered cases already
-- create public.jobs, public.suppliers, public.purchase_orders and the API roles in reduced shapes
-- (checked here); the three tables reference only jobs(id), suppliers(id) and purchase_orders(id),
-- so nothing is added.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs', 'public.suppliers', 'public.purchase_orders'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'job materials setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
   RAISE EXCEPTION 'job materials setup: role % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
