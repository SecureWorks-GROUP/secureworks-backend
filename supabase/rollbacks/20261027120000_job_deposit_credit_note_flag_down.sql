-- Rollback for 20261027120000_job_deposit_credit_note_flag.sql.
--
-- Roll the matching ops-api back first: it writes and reads the column and the new reason.
-- A deposit_credited flag still on a record is taken off first, so the narrower check can
-- be put back; its deposit_flagged job_events row stays as history, so read those rows
-- before rolling back. Re-running it is a no-op.

UPDATE public.job_deposit_advance_state
   SET flag = NULL,
       flag_at = NULL,
       flag_invoice_id = NULL,
       flag_invoice_number = NULL,
       flag_invoice_status = NULL,
       flag_cleared_at = NULL,
       flag_cleared_by = NULL,
       updated_at = now()
 WHERE flag = 'deposit_credited';
ALTER TABLE public.job_deposit_advance_state
  DROP CONSTRAINT IF EXISTS job_deposit_advance_state_flag_check;
ALTER TABLE public.job_deposit_advance_state
  ADD CONSTRAINT job_deposit_advance_state_flag_check
  CHECK (flag IN ('deposit_voided', 'deposit_unpaid'));
ALTER TABLE public.job_deposit_advance_state
  DROP COLUMN IF EXISTS counted_credit_note_ids;
