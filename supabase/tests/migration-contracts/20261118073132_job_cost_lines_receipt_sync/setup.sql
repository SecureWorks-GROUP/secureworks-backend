-- Earlier registered cases create a stand-in expense_receipts with only a few
-- columns. Add the live columns this sync reads and its trigger lists
-- (spine 20260322000010 and evidence contract 20260506112430 are not registered).
ALTER TABLE public.expense_receipts
  ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  ADD COLUMN IF NOT EXISTS vendor_name text,
  ADD COLUMN IF NOT EXISTS receipt_date date,
  ADD COLUMN IF NOT EXISTS total_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS gst_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'unknown';
