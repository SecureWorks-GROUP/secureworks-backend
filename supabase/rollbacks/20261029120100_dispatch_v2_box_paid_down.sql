-- Down for 20261029120100_dispatch_v2_box_paid. Roll ops-api back first: the
-- dispatch_v2_mark_paid and dispatch_v2_undo_paid presses, the dispatch_v2_materials read, the
-- pipeline&dispatch=1&board=v2 list read and the dispatch_arrival read name these columns.
-- Drops the check and the three job_material_suppliers columns; every supplier box stays.
-- Every paid stamp is lost with the columns (the audit lines in job_events stay).
ALTER TABLE public.job_material_suppliers DROP CONSTRAINT IF EXISTS job_material_suppliers_paid_stamp;
ALTER TABLE public.job_material_suppliers
  DROP COLUMN IF EXISTS paid_at,
  DROP COLUMN IF EXISTS paid_by,
  DROP COLUMN IF EXISTS paid_by_email;
