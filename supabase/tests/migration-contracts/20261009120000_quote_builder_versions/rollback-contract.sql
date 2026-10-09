-- Rollback contract: 20261009120000_quote_builder_versions. The down drops the table and its
-- guard function and nothing else; the tables it pointed at remain.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.quote_builder_versions') IS NOT NULL THEN
  RAISE EXCEPTION 'quote builder rollback contract: quote_builder_versions still exists';
 END IF;
 IF to_regprocedure('public.quote_builder_versions_guard()') IS NOT NULL THEN
  RAISE EXCEPTION 'quote builder rollback contract: quote_builder_versions_guard() still exists';
 END IF;
 IF to_regclass('public.jobs') IS NULL OR to_regclass('public.job_variations') IS NULL
    OR to_regclass('public.job_documents') IS NULL THEN
  RAISE EXCEPTION 'quote builder rollback contract: the down removed a table it does not own';
 END IF;
END $$;
