-- After the down migration: the table is back to four event types with an
-- invoice on every row, and it is still there, append-only.
DO $$
BEGIN
  IF to_regclass('public.trade_invoice_events') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: trade_invoice_events must remain';
  END IF;
  IF to_regclass('public.trade_invoice_events_submit_refused_idx') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.trade_invoice_events'::regclass
         AND conname IN ('trade_invoice_events_invoice_required', 'trade_invoice_events_submit_refused_detail')
     ) THEN
    RAISE EXCEPTION 'rollback contract: an object of 20261111194500 survived its down migration';
  END IF;
  IF NOT (SELECT attnotnull FROM pg_attribute
          WHERE attrelid = 'public.trade_invoice_events'::regclass AND attname = 'trade_invoice_id') THEN
    RAISE EXCEPTION 'rollback contract: trade_invoice_id must be required again';
  END IF;
  BEGIN
    INSERT INTO public.trade_invoice_events (trade_invoice_id, event_type, actor, detail)
    VALUES (gen_random_uuid(), 'submit_refused', 'trade:x', '{"user_id":"u","action":"a","http_status":409}');
    RAISE EXCEPTION 'rollback contract: submit_refused is still accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
BEGIN;
INSERT INTO public.trade_invoice_events (trade_invoice_id, event_type, actor)
VALUES (gen_random_uuid(), 'voided_bill_released', 'system:xero-sync');
ROLLBACK;
