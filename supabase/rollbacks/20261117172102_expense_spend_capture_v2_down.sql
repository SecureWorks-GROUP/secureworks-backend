DELETE FROM public.feature_flags
WHERE flag_name IN ('spend_capture_v2', 'inbox_link_v1') AND enabled = false;

ALTER TABLE public.expense_receipts
  DROP CONSTRAINT IF EXISTS expense_receipts_job_or_stock_not_both,
  DROP COLUMN IF EXISTS stock_division,
  DROP COLUMN IF EXISTS capture_version;

-- Retain the reimbursement column, FK and unique rule shared with P1-03.
-- Removing them could erase saved links or undo the other ticket's guarantee.
