-- Down for 20261105170000_dispatch_v2_outlook_orders. Roll back ops-api first
-- (dispatch_v2_outlook_order.ts calls the function and the Dispatch reads
-- select the origin column).
--
-- Orders already recorded from Outlook are kept as ordinary sent orders (their
-- rows, boxes and job_events stay); only the marks that say they came from
-- Outlook go. After a roll forward the scan could not tell them apart and
-- would leave those jobs alone, as it leaves any job with a Dispatch order.
DROP FUNCTION IF EXISTS public.dispatch_v2_record_outlook_order(jsonb);
DROP INDEX IF EXISTS public.dispatch_supplier_order_emails_source_event_idx;
ALTER TABLE public.dispatch_supplier_order_emails
  DROP CONSTRAINT IF EXISTS dispatch_supplier_order_emails_outlook_shape,
  DROP CONSTRAINT IF EXISTS dispatch_supplier_order_emails_origin_valid,
  DROP COLUMN IF EXISTS source_business_event_id,
  DROP COLUMN IF EXISTS origin;
