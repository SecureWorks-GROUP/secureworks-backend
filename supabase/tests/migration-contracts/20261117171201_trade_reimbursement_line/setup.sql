-- The registered stack supplies invoice and cost views. Receipts are otherwise unrelated.
CREATE TABLE IF NOT EXISTS public.expense_receipts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
