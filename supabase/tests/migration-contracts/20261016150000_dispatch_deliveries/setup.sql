-- Prerequisites for 20261016150000_dispatch_deliveries. Earlier registered cases create
-- public.users (id primary key) and public.purchase_orders with the live columns slice 6 reads
-- (delivery dates added here, nullable, as live has them) and the live trg_po_updated trigger.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.users', 'public.purchase_orders'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'dispatch deliveries setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS delivery_date date,
  ADD COLUMN IF NOT EXISTS confirmed_delivery_date date,
  ADD COLUMN IF NOT EXISTS delivery_confirmed_at timestamptz;
