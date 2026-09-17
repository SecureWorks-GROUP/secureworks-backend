-- Explicit operator rollback only. Drops the Booking pack/stamp store.
DROP INDEX IF EXISTS public.idx_sales_booking_packs_latest;
DROP TABLE IF EXISTS public.sales_booking_packs;
