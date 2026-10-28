-- Down for 20261028170000_dispatch_v2_material_stages. Roll ops-api back first: the
-- dispatch_v2_set_material_stage press, the dispatch_v2_materials read, the
-- pipeline&dispatch=1&board=v2 list read and the dispatch_arrival read name these columns.
-- Drops the check and the three job_material_suppliers columns; every supplier box stays.
-- Every material stage a person set is lost with the columns (the audit lines in
-- job_events stay).
ALTER TABLE public.job_material_suppliers DROP CONSTRAINT IF EXISTS job_material_suppliers_material_stage_valid;
ALTER TABLE public.job_material_suppliers
  DROP COLUMN IF EXISTS material_stage,
  DROP COLUMN IF EXISTS material_stage_set_at,
  DROP COLUMN IF EXISTS material_stage_set_by_email;
