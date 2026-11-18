SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.expense_receipts
  DROP COLUMN IF EXISTS unbooked_job_id;
