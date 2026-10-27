-- Deposit flag: a deposit refunded by credit note (captain, 27 Oct 2026: "1. fix").
--
-- The deposit advance (20261026160000) flags a deposit voided or no longer paid after it
-- moved the job. The usual Xero refund is neither: the payment is taken off, a client
-- credit note is allocated against the deposit invoice and refunded, and the invoice reads
-- PAID with nothing due again. Our Xero copy already keeps the allocations
-- (xero_invoices.raw_json->CreditNotes), so ops-api job_deposit_advance.ts reads them and
-- raises the same flag with reason deposit_credited. The flag only flags: the job is never
-- moved back, nobody is texted and Xero is never touched. Contract:
-- docs/job-deposit-advance-v1.md.
--
-- This migration:
--   1. job_deposit_advance_state.counted_credit_note_ids: the credit notes already
--      allocated against the counted deposits at the move. A credit note that was there at
--      the move (often a rounding credit that closed the invoice) is part of how it was
--      paid; only one allocated after the move is a refund.
--   2. Widens the flag check to admit deposit_credited.
--
-- Apply before the matching ops-api: it writes and reads the column and the new reason.
-- Rollback: supabase/rollbacks/20261027120000_job_deposit_credit_note_flag_down.sql.

ALTER TABLE public.job_deposit_advance_state
  ADD COLUMN IF NOT EXISTS counted_credit_note_ids text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.job_deposit_advance_state.counted_credit_note_ids IS
  'Deposit credit note flag (20261027120000): the Xero CreditNoteIDs already allocated against the counted deposit invoices when the automatic move moved the job. A credit note allocated against a counted deposit after the move flags deposit_credited. Written only by ops-api job_deposit_advance.ts.';

ALTER TABLE public.job_deposit_advance_state
  DROP CONSTRAINT IF EXISTS job_deposit_advance_state_flag_check;
ALTER TABLE public.job_deposit_advance_state
  ADD CONSTRAINT job_deposit_advance_state_flag_check
  CHECK (flag IN ('deposit_voided', 'deposit_unpaid', 'deposit_credited'));
