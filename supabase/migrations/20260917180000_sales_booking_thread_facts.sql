-- Sales Booking thread-facts cache (17 Sep 2026).
--
-- Live thread reads on sales_booking_read hit GHL 429 and exhaust the time
-- budget, so page load re-reads every conversation. kind=thread_facts stores
-- the last derived facts per resource as one packs-style row: payload.facts
-- is keyed by opportunity id and each entry carries read_at.
--
-- Latest = greatest as_of per (resource, week_start, kind), same as pack/stamp.
-- Thread facts are not week-scoped; writers use week_start = 1970-01-05
-- (a Monday, satisfies the existing ISODOW check).
--
-- No send, no calendar write, no GHL write. Service-role only, same as pack.

ALTER TABLE public.sales_booking_packs
  DROP CONSTRAINT IF EXISTS sales_booking_packs_kind_check;

ALTER TABLE public.sales_booking_packs
  ADD CONSTRAINT sales_booking_packs_kind_check
  CHECK (kind IN ('pack', 'stamp', 'thread_facts'));

COMMENT ON TABLE public.sales_booking_packs IS
  'Engine pack (kind=pack), captain stamp (kind=stamp), and cached GHL thread facts (kind=thread_facts) for the Sales Booking door. Latest = greatest as_of per (resource, week_start, kind). Thread facts use week_start 1970-01-05. Service-role only.';
