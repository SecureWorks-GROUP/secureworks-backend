-- After the down migration the function is gone and nothing else it read was
-- touched.
DO $$
BEGIN
  IF to_regprocedure('public.job_quote_values(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'd1 rollback: job_quote_values still exists';
  END IF;
  IF to_regclass('public.job_documents') IS NULL OR to_regclass('public.quote_revisions') IS NULL THEN
    RAISE EXCEPTION 'd1 rollback: a table it read was dropped';
  END IF;
END $$;
