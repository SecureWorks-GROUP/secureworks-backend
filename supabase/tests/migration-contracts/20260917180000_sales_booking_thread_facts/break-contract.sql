ALTER TABLE public.sales_booking_packs
  DROP CONSTRAINT IF EXISTS sales_booking_packs_kind_check;
ALTER TABLE public.sales_booking_packs
  ADD CONSTRAINT sales_booking_packs_kind_check
  CHECK (kind IN ('pack', 'stamp'));
