-- Remove the one-filed-copy-per-version rule; the contract must then fail on the second insert.
DROP INDEX public.ux_job_docs_quote_builder_extra;
