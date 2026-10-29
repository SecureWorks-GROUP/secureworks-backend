-- Prerequisites for 20261029200000_context_job_picture. Earlier registered
-- cases create the jobs, parties, crew, purchase orders, Materials by
-- supplier, work orders, Xero Projects and placed bills, and the B0 keys. This
-- adds only the columns the picture reads that a stub may lack. Fail closed if
-- a table is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.jobs', 'public.job_contacts', 'public.job_assignments', 'public.users',
                           'public.purchase_orders', 'public.job_material_suppliers', 'public.job_material_lines',
                           'public.work_orders', 'public.xero_projects', 'public.job_materials_facts'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'job picture setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.job_material_suppliers
  ADD COLUMN IF NOT EXISTS delivery_date date,
  ADD COLUMN IF NOT EXISTS material_stage text,
  ADD COLUMN IF NOT EXISTS is_main_supplier boolean NOT NULL DEFAULT false;
ALTER TABLE public.xero_projects
  ADD COLUMN IF NOT EXISTS status text;
