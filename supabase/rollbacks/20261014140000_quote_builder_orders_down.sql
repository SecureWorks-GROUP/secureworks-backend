-- Down for 20261014140000_quote_builder_orders.
-- Roll ops-api back first: acceptance filters on these columns, and the make
-- actions read and write them. Dropping the columns while that code is live
-- makes the acceptance read fail closed (no draft work order is approved and
-- no draft purchase order is pushed).
DELETE FROM public.feature_flags WHERE flag_name = 'quote_builder_orders_v1';
DROP INDEX IF EXISTS public.uq_work_orders_one_quote_builder_version;
DROP INDEX IF EXISTS public.idx_purchase_orders_quote_builder_version;
ALTER TABLE public.work_orders DROP COLUMN IF EXISTS quote_builder_version_id;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS quote_builder_version_id;
