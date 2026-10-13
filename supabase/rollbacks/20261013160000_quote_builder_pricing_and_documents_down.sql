-- Down for 20261013160000_quote_builder_pricing_and_documents. Drops the extra-document index on job_documents and the pricing
-- settings table, and nothing else: filed scope of works documents are ordinary job_documents rows
-- and stay. Roll ops-api back first: the deployed quote_builder_get_job reads the settings table.
DROP INDEX IF EXISTS public.ux_job_docs_quote_builder_extra;
DROP TABLE IF EXISTS public.quote_builder_settings;
