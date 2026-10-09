-- Down for 20261009120000_quote_builder_versions. Drops the quote builder table, its guard and
-- the private-job request index on jobs.
-- Run only before any version has been issued in production: issued rows are the record of what
-- was quoted, and dropping the table discards them. The job_documents rows and job_media photos
-- the builder wrote are ordinary rows in those tables and are left in place.
DROP INDEX IF EXISTS public.ux_jobs_quote_builder_request_id;
DROP TABLE IF EXISTS public.quote_builder_versions;
DROP FUNCTION IF EXISTS public.quote_builder_versions_guard();
