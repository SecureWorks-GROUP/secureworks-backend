-- Down for 20261014140000_quote_builder_orders.
-- This deletes the flag row first. Current ops-api treats a missing flag as
-- off, so acceptance and pushPOToXero do not touch these columns and the make
-- actions already refuse. Dropping the columns is safe against that code.
-- An older ops-api that always filtered on the columns must be rolled back
-- first, or the acceptance read fails and no draft work order is approved
-- and no draft purchase order is pushed.
DELETE FROM public.feature_flags WHERE flag_name = 'quote_builder_orders_v1';
DROP INDEX IF EXISTS public.uq_work_orders_one_quote_builder_version;
DROP INDEX IF EXISTS public.idx_purchase_orders_quote_builder_version;
ALTER TABLE public.work_orders DROP COLUMN IF EXISTS quote_builder_version_id;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS quote_builder_version_id;
