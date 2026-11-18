\ir ../../../migrations/20261118999906_expense_unbooked_job_mark.sql
BEGIN;
DO $$
DECLARE receipt uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'expense_receipts' AND column_name = 'unbooked_job_id'
    AND data_type = 'uuid' AND is_nullable = 'YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION 'unbooked_job_id must be a nullable uuid with no default';
  END IF;
  -- An insert that names no mark, as every existing writer does, starts unmarked.
  INSERT INTO public.expense_receipts (receipt_photo_url) VALUES ('ZZTEST-receipt') RETURNING id INTO receipt;
  IF NOT EXISTS (SELECT 1 FROM public.expense_receipts WHERE id = receipt AND unbooked_job_id IS NULL) THEN
    RAISE EXCEPTION 'a receipt must start unmarked';
  END IF;
  -- Moving the job or clearing it never fails because of the mark.
  UPDATE public.expense_receipts SET unbooked_job_id = gen_random_uuid() WHERE id = receipt;
  UPDATE public.expense_receipts SET job_id = NULL WHERE id = receipt;
END $$;
ROLLBACK;
