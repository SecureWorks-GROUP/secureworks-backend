-- Uses the registered event store (20261106163712) and its receipt_released
-- widening (20261117220101). Nothing more is needed.
DO $$ BEGIN
  IF to_regclass('public.trade_invoice_events') IS NULL THEN
    RAISE EXCEPTION 'trade_invoice_events prerequisite missing';
  END IF;
END $$;
