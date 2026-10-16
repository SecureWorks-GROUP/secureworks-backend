-- Rollback contract: 20261016150000_dispatch_deliveries. The down drops the check and the six
-- columns and leaves purchase_orders, its dates and delivery_confirmed_at in place.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'purchase_orders'
             AND column_name IN ('confirmed_delivery_set_at', 'confirmed_delivery_set_by',
                                 'confirmed_delivery_set_by_email', 'delivery_sighted_at',
                                 'delivery_sighted_by', 'delivery_sighted_by_email')) THEN
  RAISE EXCEPTION 'dispatch deliveries rollback contract: a slice 6 column still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_delivery_sighted_named') THEN
  RAISE EXCEPTION 'dispatch deliveries rollback contract: the sighting check still exists';
 END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'purchase_orders'
      AND column_name IN ('delivery_date', 'confirmed_delivery_date', 'delivery_confirmed_at')) <> 3 THEN
  RAISE EXCEPTION 'dispatch deliveries rollback contract: the down removed something it does not own';
 END IF;
END $$;
