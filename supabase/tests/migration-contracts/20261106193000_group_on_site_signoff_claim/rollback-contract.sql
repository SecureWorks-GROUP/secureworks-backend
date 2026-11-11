-- The down removes only the function; the sign-off table and its key index stay.
DO $$ BEGIN
  IF to_regproc('public.record_on_site_client_signoff') IS NOT NULL THEN
    RAISE EXCEPTION 'on-site claim rollback: function still present';
  END IF;
  IF to_regclass('public.job_client_signoffs_capture_request_key') IS NULL THEN
    RAISE EXCEPTION 'on-site claim rollback: key index must stay';
  END IF;
  PERFORM 1 FROM public.job_client_signoffs LIMIT 1;
END $$;
