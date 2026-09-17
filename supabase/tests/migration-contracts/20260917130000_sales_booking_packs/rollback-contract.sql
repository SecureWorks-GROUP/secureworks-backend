-- After the down migration the store must be gone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'sales_booking_packs'
  ) THEN
    RAISE EXCEPTION 'rollback-contract: sales_booking_packs still exists';
  END IF;
END $$;
