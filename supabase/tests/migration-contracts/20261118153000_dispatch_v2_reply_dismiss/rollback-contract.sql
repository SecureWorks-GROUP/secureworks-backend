-- After the down: the dismissed columns and their checks are gone, and a reply still saves as before. Writes rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dispatch_v2_supplier_emails'
       AND column_name IN ('dismissed_at', 'dismissed_by', 'dismissed_by_email', 'dismissed_source')
  ) THEN
    RAISE EXCEPTION 'rollback left a dismissed column';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname IN ('dispatch_v2_supplier_emails_dismissed_shape', 'dispatch_v2_supplier_emails_dismissed_source_valid',
                       'dispatch_v2_supplier_emails_dismissed_by_fkey')
  ) THEN
    RAISE EXCEPTION 'rollback left a dismissed constraint';
  END IF;
  INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, rung)
  VALUES ('00000000-0000-0000-0000-000000000001', 'matched', 'job_number');
END $$;
ROLLBACK;
