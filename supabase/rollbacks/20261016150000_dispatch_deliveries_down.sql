-- Down for 20261016150000_dispatch_deliveries. Roll ops-api back first: the deployed
-- dispatch_delivery_* actions, the extended dispatch_materials read, the pipeline&dispatch=1 order
-- read and the reply reader name these columns. Drops the check and the six purchase_orders columns;
-- every confirmed date, expected date and delivery_confirmed_at stays. Who set a date by hand and every
-- sighting are lost with the columns (the job_events rows keep the history).
ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_delivery_sighted_named;
ALTER TABLE public.purchase_orders
  DROP COLUMN IF EXISTS confirmed_delivery_set_at,
  DROP COLUMN IF EXISTS confirmed_delivery_set_by,
  DROP COLUMN IF EXISTS confirmed_delivery_set_by_email,
  DROP COLUMN IF EXISTS delivery_sighted_at,
  DROP COLUMN IF EXISTS delivery_sighted_by,
  DROP COLUMN IF EXISTS delivery_sighted_by_email;
