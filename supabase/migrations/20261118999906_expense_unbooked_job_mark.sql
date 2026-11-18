-- cl-receipt-ownjob: mark a receipt saved on a job its submitter is not booked on.
-- Merge adds one nullable column and its NOT VALID check only. No trigger, schedule,
-- switch, index or historical row write. Placeholder number: the keeper stamps it.
-- Locks expense_receipts briefly (ADD COLUMN and ADD CONSTRAINT NOT VALID, no scan).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.expense_receipts
  ADD COLUMN IF NOT EXISTS unbooked_job_id uuid;

COMMENT ON COLUMN public.expense_receipts.unbooked_job_id IS
  'The job this receipt was saved on while its submitter held no confirmed booking there (ops-api expense_own_job.ts). Null: booked, office, or no job. Approving a marked receipt needs a deliberate confirm.';

-- The mark only ever names the receipt's own job. NOT VALID: no scan of existing rows
-- (all null), enforced on new and updated rows.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expense_receipts'::regclass AND conname = 'expense_receipts_unbooked_job_is_job'
  ) THEN
    ALTER TABLE public.expense_receipts ADD CONSTRAINT expense_receipts_unbooked_job_is_job
      CHECK (unbooked_job_id IS NULL OR unbooked_job_id IS NOT DISTINCT FROM job_id) NOT VALID;
  END IF;
END $$;
