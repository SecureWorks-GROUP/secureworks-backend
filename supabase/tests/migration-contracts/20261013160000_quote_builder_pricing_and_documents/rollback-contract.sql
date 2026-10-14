-- Rollback contract: 20261013160000_quote_builder_pricing_and_documents. The down drops the settings table and the
-- extra-document index, and nothing else: job_documents remains and takes rows as before, a second
-- scope of works row for one version included.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.quote_builder_settings') IS NOT NULL THEN
  RAISE EXCEPTION 'quote builder pricing rollback contract: quote_builder_settings still exists';
 END IF;
 IF to_regclass('public.ux_job_docs_quote_builder_extra') IS NOT NULL THEN
  RAISE EXCEPTION 'quote builder pricing rollback contract: ux_job_docs_quote_builder_extra still exists';
 END IF;
 IF to_regclass('public.job_documents') IS NULL OR to_regclass('public.jobs') IS NULL THEN
  RAISE EXCEPTION 'quote builder pricing rollback contract: the down removed a table it does not own';
 END IF;
 BEGIN
  INSERT INTO public.jobs (id, org_id, status, type)
  VALUES ('9b000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'processing', 'repair');
  INSERT INTO public.job_documents (job_id, type, version, metadata)
  VALUES ('9b000000-0000-4000-8000-000000000002', 'other', 1,
          '{"quote_builder_version_id":"9b000000-0000-4000-8000-0000000000a1","quote_builder_document":"scope_of_works"}'),
         ('9b000000-0000-4000-8000-000000000002', 'other', 1,
          '{"quote_builder_version_id":"9b000000-0000-4000-8000-0000000000a1","quote_builder_document":"scope_of_works"}');
  RAISE EXCEPTION 'rollback-probe-ok';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'rollback-probe-ok' THEN RAISE; END IF;
 END;
END $$;
