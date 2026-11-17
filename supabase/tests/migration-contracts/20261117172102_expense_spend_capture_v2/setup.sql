-- Earlier registered cases provide jobs, trade_invoice_lines and feature_flags.
CREATE TABLE IF NOT EXISTS public.expense_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES public.jobs(id),
  receipt_photo_url text NOT NULL
);
