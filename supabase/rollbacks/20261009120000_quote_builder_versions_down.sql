-- Down for 20261009120000_quote_builder_versions. Drops the quote builder table and its guard.
-- Run only before any version has been issued in production: issued rows are the record of what
-- was quoted, and dropping the table discards them. The job_documents rows and job_media photos
-- the builder wrote are ordinary rows in those tables and are left in place.
DROP TABLE IF EXISTS public.quote_builder_versions;
DROP FUNCTION IF EXISTS public.quote_builder_versions_guard();
