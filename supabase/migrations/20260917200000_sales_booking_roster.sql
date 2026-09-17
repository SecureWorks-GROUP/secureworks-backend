-- Sales Booking roster cache (17 Sep 2026).
--
-- Widens sales_booking_packs.kind to include roster. Persist grain, resume,
-- and complete-vs-incomplete rules live in
-- docs/sales-booking-read-contract-2026-09-16.md.
--
-- Latest = greatest as_of per (resource, week_start, kind). Writers insert
-- then delete older as_of only.
--
-- No send, no calendar write, no GHL write. Service-role only, same as pack.

ALTER TABLE public.sales_booking_packs
  DROP CONSTRAINT IF EXISTS sales_booking_packs_kind_check;

ALTER TABLE public.sales_booking_packs
  ADD CONSTRAINT sales_booking_packs_kind_check
  CHECK (kind IN ('pack', 'stamp', 'thread_facts', 'roster'));

COMMENT ON TABLE public.sales_booking_packs IS
  'Engine pack (kind=pack), captain stamp (kind=stamp), cached GHL thread facts (kind=thread_facts), and cached GHL opportunity roster (kind=roster) for the Sales Booking door. Latest = greatest as_of per (resource, week_start, kind). Thread facts and roster use week_start 1970-01-05. Service-role only.';
