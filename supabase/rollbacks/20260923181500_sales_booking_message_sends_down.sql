-- Down: drop the send ledger. Only safe before any live send was recorded.
DROP TABLE IF EXISTS public.sales_booking_message_sends;
DROP FUNCTION IF EXISTS public.sales_booking_message_sends_settle_once();
