-- Rollback for 20261002090000_sales_booking_routes.sql.
-- Drops only what that migration created. Run it only after the matching
-- edge code is rolled back: the booking read, approvals and presses read
-- public.sales_booking_routes and refuse every visit without it. Dropping
-- the audit discards the routing history: export it first
-- (select * from public.sales_booking_routes / sales_booking_route_changes).

DROP TRIGGER IF EXISTS sales_booking_route_changes_append_only
  ON public.sales_booking_route_changes;
DROP FUNCTION IF EXISTS public.sales_booking_route_write(
  text, text, jsonb, timestamptz, uuid, text, text
);
DROP TABLE IF EXISTS public.sales_booking_route_changes;
DROP TABLE IF EXISTS public.sales_booking_routes;
DROP FUNCTION IF EXISTS public.sales_booking_route_changes_append_only();
