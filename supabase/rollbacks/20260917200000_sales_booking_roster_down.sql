-- Explicit operator rollback only. Drops cached roster rows and restores
-- the pack/stamp/thread_facts kind check.

DELETE FROM public.sales_booking_packs WHERE kind = 'roster';

ALTER TABLE public.sales_booking_packs
  DROP CONSTRAINT IF EXISTS sales_booking_packs_kind_check;

ALTER TABLE public.sales_booking_packs
  ADD CONSTRAINT sales_booking_packs_kind_check
  CHECK (kind IN ('pack', 'stamp', 'thread_facts'));

COMMENT ON TABLE public.sales_booking_packs IS
  'Engine pack (kind=pack), captain stamp (kind=stamp), and cached GHL thread facts (kind=thread_facts) for the Sales Booking door. Latest = greatest as_of per (resource, week_start, kind). Thread facts use week_start 1970-01-05. Service-role only.';
