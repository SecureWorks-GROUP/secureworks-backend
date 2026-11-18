DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'expense_receipts' AND column_name = 'unbooked_job_id') THEN
    RAISE EXCEPTION 'unbooked_job_id remains after rollback';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'expense_receipts' AND column_name = 'job_id') THEN
    RAISE EXCEPTION 'rollback removed the receipt job column';
  END IF;
END $$;
