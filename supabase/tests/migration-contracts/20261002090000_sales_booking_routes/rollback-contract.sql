-- The down migration removes every object the forward migration created.
DO $$
BEGIN
  IF to_regclass('public.sales_booking_routes') IS NOT NULL
     OR to_regclass('public.sales_booking_route_changes') IS NOT NULL THEN
    RAISE EXCEPTION 'sales_booking_routes rollback: a table survived';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'sales_booking_route_write', 'sales_booking_route_changes_append_only'
    )
  ) THEN
    RAISE EXCEPTION 'sales_booking_routes rollback: a function survived';
  END IF;
END $$;
