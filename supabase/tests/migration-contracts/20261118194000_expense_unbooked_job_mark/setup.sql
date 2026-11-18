-- Earlier registered cases provide jobs and expense_receipts (20261117172102).
CREATE TABLE IF NOT EXISTS public.expense_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid,
  receipt_photo_url text NOT NULL
);
