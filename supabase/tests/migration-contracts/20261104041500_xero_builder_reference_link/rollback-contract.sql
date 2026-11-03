-- After the down: the candidate read, the stamp function, its trigger and the column are gone.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regprocedure('public.xero_builder_reference_candidates(text[])') IS NOT NULL
     OR to_regprocedure('public.xero_invoices_stamp_job_linked_at()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.xero_invoices'::regclass AND tgname = 'xero_invoices_job_linked_at')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'xero_invoices' AND column_name = 'job_linked_at') THEN
    RAISE EXCEPTION 'rollback left the B3 builder reference objects behind';
  END IF;
END $$;
SELECT count(*) FROM public.xero_invoices;
