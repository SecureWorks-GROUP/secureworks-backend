-- Down: drop the executor ledger. Only safe before any live book or send.
DROP TABLE IF EXISTS public.sales_booking_executions;
DROP FUNCTION IF EXISTS public.sales_booking_executions_settle_once();
