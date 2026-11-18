\ir ../../../migrations/20261118999906_expense_unbooked_job_mark.sql
BEGIN;
DO $$
DECLARE receipt uuid; seen_constraint text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'expense_receipts' AND column_name = 'unbooked_job_id'
    AND data_type = 'uuid' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'unbooked_job_id must be a nullable uuid';
  END IF;
  -- An unmarked receipt, with or without a job, inserts as before.
  INSERT INTO public.expense_receipts (receipt_photo_url) VALUES ('ZZTEST-receipt') RETURNING id INTO receipt;
  IF NOT EXISTS (SELECT 1 FROM public.expense_receipts WHERE id = receipt AND unbooked_job_id IS NULL) THEN
    RAISE EXCEPTION 'a receipt must start unmarked';
  END IF;
  -- A mark naming another job than the receipt's own is refused.
  BEGIN
    UPDATE public.expense_receipts SET unbooked_job_id = gen_random_uuid() WHERE id = receipt;
    RAISE EXCEPTION 'a mark naming another job was accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS seen_constraint = CONSTRAINT_NAME;
    IF seen_constraint <> 'expense_receipts_unbooked_job_is_job' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
