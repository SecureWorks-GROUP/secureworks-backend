-- Down for 20261014120000_job_materials_by_supplier. Drops the three Dispatch materials tables and
-- nothing else: jobs, suppliers and purchase_orders remain, and no purchase order ever pointed at a
-- line. Roll ops-api back first: the deployed dispatch_materials read, the six dispatch_materials_*
-- writes and the pipeline dispatch=1 read all name these tables. The lines go first, because their
-- foreign key points at the chosen suppliers.
DROP TABLE IF EXISTS public.job_material_lines;
DROP TABLE IF EXISTS public.job_material_suppliers;
DROP TABLE IF EXISTS public.job_dispatch_workings;
