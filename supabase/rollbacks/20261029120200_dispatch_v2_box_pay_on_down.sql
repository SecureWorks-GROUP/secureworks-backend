-- Down for 20261029120200_dispatch_v2_box_pay_on. Roll ops-api back first: the
-- dispatch_v2_set_pay_on press, the dispatch_v2_materials read, the
-- pipeline&dispatch=1&board=v2 list read and the dispatch_arrival read name these columns.
-- Drops the check and the four job_material_suppliers columns; every supplier box stays.
-- Every Pay on tag is lost with the columns (the audit lines in job_events stay).
ALTER TABLE public.job_material_suppliers DROP CONSTRAINT IF EXISTS job_material_suppliers_pay_on_stamp;
ALTER TABLE public.job_material_suppliers
  DROP COLUMN IF EXISTS pay_on,
  DROP COLUMN IF EXISTS pay_on_set_at,
  DROP COLUMN IF EXISTS pay_on_set_by,
  DROP COLUMN IF EXISTS pay_on_set_by_email;
