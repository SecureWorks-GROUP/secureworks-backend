-- Drop the state check. The contract must then refuse the row itself.
ALTER TABLE public.xero_bill_attachment_reads
  DROP CONSTRAINT xero_bill_attachment_reads_state_check;
