-- After the down: both item 16b functions are gone, and the request table the reader serves is untouched.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regprocedure('public.dispatch_v2_tray_pdf_read_request(integer)') IS NOT NULL
     OR to_regprocedure('public.dispatch_v2_tray_pdf_reads(uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION '16b rollback: a function is still there';
  END IF;
  IF to_regclass('public.context_document_text_requests') IS NULL THEN
    RAISE EXCEPTION '16b rollback: the request table went with it';
  END IF;
  PERFORM 1 FROM public.context_document_text_requests LIMIT 1;
END $$;
