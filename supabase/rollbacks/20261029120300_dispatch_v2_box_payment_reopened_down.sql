-- Down for 20261029120300_dispatch_v2_box_payment_reopened. Roll ops-api back
-- first: the dispatch_v2_set_material_stage press, the dispatch_v2_materials
-- read, the pipeline&dispatch=1&board=v2 list read and the dispatch_arrival
-- read name this column.
-- Drops the one job_material_suppliers column; every supplier box stays. A
-- re-opened payment is then read from the stored Awaiting payment pick only.
ALTER TABLE public.job_material_suppliers
  DROP COLUMN IF EXISTS payment_reopened_at;
