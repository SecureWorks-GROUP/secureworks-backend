-- P2-06.1 receipt storage and P2-08.1 Inbox Link rollout. Both switches stay off.
ALTER TABLE public.expense_receipts
  ADD COLUMN IF NOT EXISTS stock_division text
    CHECK (stock_division IS NULL OR stock_division IN ('patios', 'fencing', 'insurance')),
  ADD COLUMN IF NOT EXISTS capture_version int;

-- Shared with P1-03. Either migration may arrive first.
ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS expense_receipt_id uuid REFERENCES public.expense_receipts(id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = 'public.trade_invoice_lines'::regclass
      AND i.indisunique AND i.indisvalid AND i.indnkeyatts = 1
      AND a.attname = 'expense_receipt_id'
      AND (i.indpred IS NULL OR pg_get_expr(i.indpred, i.indrelid) = '(expense_receipt_id IS NOT NULL)')
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS trade_invoice_lines_one_receipt
      ON public.trade_invoice_lines (expense_receipt_id) WHERE expense_receipt_id IS NOT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expense_receipts'::regclass AND conname = 'expense_receipts_job_or_stock_not_both'
  ) THEN
    ALTER TABLE public.expense_receipts ADD CONSTRAINT expense_receipts_job_or_stock_not_both
      CHECK (job_id IS NULL OR stock_division IS NULL);
  END IF;
END $$;

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('spend_capture_v2', false, 'Receipt capture with division stock and capture version.'),
  ('inbox_link_v1', false, 'Signed-in staff Inbox Link checks bills, target jobs and confirmed replacement.')
ON CONFLICT (flag_name) DO NOTHING;
