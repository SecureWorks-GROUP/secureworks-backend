-- Rollback contract: 20261014120000_job_materials_by_supplier. The down drops the three Dispatch
-- materials tables and nothing else: jobs, suppliers and purchase_orders remain.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.job_material_suppliers') IS NOT NULL
  OR to_regclass('public.job_material_lines') IS NOT NULL
  OR to_regclass('public.job_dispatch_workings') IS NOT NULL THEN
  RAISE EXCEPTION 'job materials rollback contract: a Dispatch materials table still exists';
 END IF;
 IF to_regclass('public.jobs') IS NULL OR to_regclass('public.suppliers') IS NULL
  OR to_regclass('public.purchase_orders') IS NULL THEN
  RAISE EXCEPTION 'job materials rollback contract: the down removed a table it does not own';
 END IF;
END $$;
