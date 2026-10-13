-- Down for 20261013160000_quote_builder_pricing_and_orders. Drops the two order links with their
-- unique indexes, the extra-document index on job_documents and the pricing settings table. The work orders and purchase orders themselves are
-- ordinary rows and stay; only the record of which quote builder version each came from is lost, so
-- after this a second press would make a second order. Roll ops-api back first: the deployed
-- quote_builder_get_job reads both columns and the settings table.
DROP INDEX IF EXISTS public.ux_job_docs_quote_builder_extra;
DROP INDEX IF EXISTS public.ux_work_orders_quote_builder_version;
DROP INDEX IF EXISTS public.ux_purchase_orders_quote_builder_version_supplier;
ALTER TABLE public.work_orders DROP COLUMN IF EXISTS quote_builder_version_id;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS quote_builder_version_id;
DROP TABLE IF EXISTS public.quote_builder_settings;
