-- Down for 20261023160000_dispatch_v2_board_arrival_dates. Roll ops-api back first: the
-- pipeline&dispatch=1&board=v2 list read and the dispatch_arrival read name these columns (each
-- reports arrival 'failed' without them, never an error). Drops the three checks and the seven
-- job_material_suppliers columns; every supplier box stays. Every delivery date and confirmation
-- on a box is lost with the columns.
ALTER TABLE public.job_material_suppliers DROP CONSTRAINT IF EXISTS job_material_suppliers_delivery_confirmed_named;
ALTER TABLE public.job_material_suppliers DROP CONSTRAINT IF EXISTS job_material_suppliers_delivery_date_stamped;
ALTER TABLE public.job_material_suppliers DROP CONSTRAINT IF EXISTS job_material_suppliers_delivery_date_source_valid;
ALTER TABLE public.job_material_suppliers
  DROP COLUMN IF EXISTS delivery_date,
  DROP COLUMN IF EXISTS delivery_date_source,
  DROP COLUMN IF EXISTS delivery_date_set_at,
  DROP COLUMN IF EXISTS delivery_date_set_by_email,
  DROP COLUMN IF EXISTS delivery_date_confirmed_at,
  DROP COLUMN IF EXISTS delivery_date_confirmed_by,
  DROP COLUMN IF EXISTS delivery_date_confirmed_by_email;
