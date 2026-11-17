-- Earlier registered cases own these tables. Mirror missing source columns only.
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS xero_contact_id text;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.dispatch_supplier_order_emails ADD COLUMN IF NOT EXISTS sent_at timestamptz;
