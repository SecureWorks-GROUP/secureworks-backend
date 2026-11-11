-- Down for 20261106120000_dispatch_v2_outlook_order_on_send. Roll back ops-api
-- first (dispatch_v2_outlook_on_send.ts calls the function and reads the scan
-- state column).
--
-- Orders already recorded by the send rule or the catch-up are kept as
-- ordinary sent Outlook orders (their rows, boxes and job_events stay).
--
-- The 5 Nov key (one order per sent email) comes back only when no sent email
-- has become two orders (one email to two suppliers). If one has, the newer
-- key is left in place and a notice says so: drop it by hand once those rows
-- are dealt with.
DROP FUNCTION IF EXISTS public.dispatch_v2_record_outlook_order_on_send(jsonb);

ALTER TABLE public.dispatch_v2_reply_scan_state
  DROP COLUMN IF EXISTS sent_orders_since;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.dispatch_supplier_order_emails
     WHERE source_business_event_id IS NOT NULL
     GROUP BY source_business_event_id HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'Some sent emails are two orders: kept dispatch_supplier_order_emails_source_event_supplier_idx';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS dispatch_supplier_order_emails_source_event_idx
      ON public.dispatch_supplier_order_emails (source_business_event_id)
      WHERE source_business_event_id IS NOT NULL;
    DROP INDEX IF EXISTS public.dispatch_supplier_order_emails_source_event_supplier_idx;
  END IF;
END $$;
