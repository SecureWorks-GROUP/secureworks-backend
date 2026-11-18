SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.expense_receipts
  DROP CONSTRAINT IF EXISTS expense_receipts_unbooked_job_is_job,
  DROP COLUMN IF EXISTS unbooked_job_id;
