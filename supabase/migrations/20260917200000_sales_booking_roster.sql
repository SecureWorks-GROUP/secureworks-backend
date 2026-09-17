-- Sales Booking roster cache (17 Sep 2026).
--
-- Live opportunity paging on sales_booking_read hits GHL 429 and spends the
-- whole door budget before threads run. kind=roster stores the last completed
-- open-pipeline enumeration per resource and week as one packs-style row.
--
-- Latest = greatest as_of per (resource, week_start, kind), same as
-- pack/stamp/thread_facts. Writers insert then delete older as_of only.
--
-- No send, no calendar write, no GHL write. Service-role only, same as pack.

ALTER TABLE public.sales_booking_packs
  DROP CONSTRAINT IF EXISTS sales_booking_packs_kind_check;

ALTER TABLE public.sales_booking_packs
  ADD CONSTRAINT sales_booking_packs_kind_check
  CHECK (kind IN ('pack', 'stamp', 'thread_facts', 'roster'));

COMMENT ON TABLE public.sales_booking_packs IS
  'Engine pack (kind=pack), captain stamp (kind=stamp), cached GHL thread facts (kind=thread_facts), and cached GHL opportunity roster (kind=roster) for the Sales Booking door. Latest = greatest as_of per (resource, week_start, kind). Thread facts use week_start 1970-01-05. Service-role only.';
