-- Explicit operator rollback only. Drops cached thread-facts rows and
-- restores the pack/stamp-only kind check.

DELETE FROM public.sales_booking_packs WHERE kind = 'thread_facts';

ALTER TABLE public.sales_booking_packs
  DROP CONSTRAINT IF EXISTS sales_booking_packs_kind_check;

ALTER TABLE public.sales_booking_packs
  ADD CONSTRAINT sales_booking_packs_kind_check
  CHECK (kind IN ('pack', 'stamp'));

COMMENT ON TABLE public.sales_booking_packs IS
  'Engine pack (kind=pack) and captain stamp (kind=stamp) for the Sales Booking door. Latest = greatest as_of per (resource, week_start, kind). Service-role only.';
