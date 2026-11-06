-- After the down: the function and the column are gone, the 5 Nov one-order-per-email index is back, and the order
-- and scan tables still answer.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regprocedure('public.dispatch_v2_record_outlook_order_on_send(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback left the function';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'dispatch_v2_reply_scan_state' AND column_name = 'sent_orders_since') THEN
    RAISE EXCEPTION 'rollback left the column';
  END IF;
  IF to_regclass('public.dispatch_supplier_order_emails_source_event_idx') IS NULL THEN
    RAISE EXCEPTION 'rollback did not restore the 5 Nov index';
  END IF;
  IF to_regclass('public.dispatch_supplier_order_emails_source_event_supplier_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback left the new index';
  END IF;
  IF to_regprocedure('public.dispatch_v2_record_outlook_order(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'rollback removed the 5 Nov function';
  END IF;
  PERFORM count(*) FROM public.dispatch_supplier_order_emails;
  PERFORM count(*) FROM public.dispatch_v2_reply_scan_state;
END $$;
