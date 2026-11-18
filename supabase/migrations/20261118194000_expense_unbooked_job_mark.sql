-- cl-receipt-ownjob: mark a receipt saved on a job its submitter is not booked on.
-- Merge adds one nullable column only: no constraint, trigger, schedule, switch,
-- index or historical row write. Placeholder number: the keeper stamps it.
-- Locks expense_receipts briefly (ADD COLUMN, nullable, no default: no rewrite, no scan).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.expense_receipts
  ADD COLUMN IF NOT EXISTS unbooked_job_id uuid;

COMMENT ON COLUMN public.expense_receipts.unbooked_job_id IS
  'The job this receipt was saved on while its submitter held no confirmed booking there (ops-api expense_own_job.ts). Null: booked, office, or no job. Approving a marked receipt needs a deliberate confirm.';
