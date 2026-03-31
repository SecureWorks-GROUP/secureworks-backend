-- Add deposit tracking columns to jobs table
-- Used by createDepositInvoice and completeAndInvoice (deposit awareness)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deposit_invoice_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deposit_amount numeric(12,2);
