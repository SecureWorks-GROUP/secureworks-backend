-- Rollback contract: 20261009120000_quote_builder_versions. The down drops the table and its
-- guard function and the private-job request index on jobs, narrows the job_media phase check back
-- to its earlier list (no row used 'quote_builder'), and nothing else; the tables it pointed at remain.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.quote_builder_versions') IS NOT NULL THEN
  RAISE EXCEPTION 'quote builder rollback contract: quote_builder_versions still exists';
 END IF;
 IF to_regprocedure('public.quote_builder_versions_guard()') IS NOT NULL THEN
  RAISE EXCEPTION 'quote builder rollback contract: quote_builder_versions_guard() still exists';
 END IF;
 IF to_regclass('public.ux_jobs_quote_builder_request_id') IS NOT NULL THEN
  RAISE EXCEPTION 'quote builder rollback contract: ux_jobs_quote_builder_request_id still exists';
 END IF;
 IF to_regclass('public.jobs') IS NULL OR to_regclass('public.job_variations') IS NULL
    OR to_regclass('public.job_documents') IS NULL THEN
  RAISE EXCEPTION 'quote builder rollback contract: the down removed a table it does not own';
 END IF;
 BEGIN
  INSERT INTO public.job_media (phase, type) VALUES ('quote_builder', 'photo');
  RAISE EXCEPTION 'quote builder rollback contract: job_media still accepts the quote_builder phase';
 EXCEPTION WHEN check_violation THEN
  NULL;
 END;
 BEGIN
  INSERT INTO public.job_media (phase, type) VALUES ('neighbour_signoff', 'photo');
  RAISE EXCEPTION 'rollback-probe-ok';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'rollback-probe-ok' THEN RAISE; END IF;
 END;
END $$;
