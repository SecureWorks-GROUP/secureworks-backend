-- After the down: the rung check is back to the five older rungs, so 'pdf_job_number' is refused again and the
-- older rungs still save. Writes rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, rung) VALUES (org, 'matched', 'job_number');
  BEGIN
    INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, rung) VALUES (org, 'matched', 'pdf_job_number');
    RAISE EXCEPTION 'rollback left the pdf_job_number rung';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
