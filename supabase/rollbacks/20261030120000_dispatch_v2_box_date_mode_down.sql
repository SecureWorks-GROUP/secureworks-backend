-- Down for 20261030120000_dispatch_v2_box_date_mode. Roll ops-api back first: the
-- dispatch_v2_set_date_mode press, dispatch_v2_make_email, the dispatch_v2_materials read,
-- the pipeline&dispatch=1&board=v2 list read and the dispatch_arrival read name these columns.
-- Drops the check and the three job_material_suppliers columns; every supplier box stays.
-- Every box's date choice is lost with the columns (the order emails keep their Date lines,
-- and the audit lines in job_events stay).
ALTER TABLE public.job_material_suppliers DROP CONSTRAINT IF EXISTS job_material_suppliers_order_date_mode;
ALTER TABLE public.job_material_suppliers
  DROP COLUMN IF EXISTS order_date_mode,
  DROP COLUMN IF EXISTS order_date_mode_set_at,
  DROP COLUMN IF EXISTS order_date_mode_set_by_email;
