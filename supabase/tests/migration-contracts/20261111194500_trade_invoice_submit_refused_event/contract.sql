-- A refused trade invoice submit leaves a record (20261111194500).

BEGIN;
-- 1. A refused submit is recorded with no invoice, and with one.
INSERT INTO public.trade_invoice_events (id, trade_invoice_id, event_type, actor, reason, detail)
VALUES
  ('00000000-0000-4000-8000-0000000000f1', NULL, 'submit_refused',
   'trade:00000000-0000-4000-8000-00000000aaaa', 'RATE_NOT_CONFIGURED',
   '{"user_id":"00000000-0000-4000-8000-00000000aaaa","action":"generate_trade_invoice","http_status":422,"code":"RATE_NOT_CONFIGURED","week_start":"2026-11-09"}'),
  ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-00000000bbbb', 'submit_refused',
   'trade:00000000-0000-4000-8000-00000000aaaa', 'WEEK_ALREADY_INVOICED',
   '{"user_id":"00000000-0000-4000-8000-00000000aaaa","action":"generate_trade_invoice","http_status":409}');

DO $$
BEGIN
  -- 2. Every other event still needs its invoice.
  BEGIN
    INSERT INTO public.trade_invoice_events (trade_invoice_id, event_type, actor)
    VALUES (NULL, 'voided_bill_released', 'system:xero-sync');
    RAISE EXCEPTION 'contract: an event with no invoice was accepted for a type that needs one';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%trade_invoice_events_invoice_required%' THEN RAISE; END IF;
  END;

  -- 3. A refused submit says who, which door and what the answer was.
  BEGIN
    INSERT INTO public.trade_invoice_events (trade_invoice_id, event_type, actor, detail)
    VALUES (NULL, 'submit_refused', 'trade:x', '{"action":"generate_trade_invoice","http_status":409}');
    RAISE EXCEPTION 'contract: a refused submit with no user was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%trade_invoice_events_submit_refused_detail%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.trade_invoice_events (trade_invoice_id, event_type, actor)
    VALUES (NULL, 'submit_refused', 'trade:x');
    RAISE EXCEPTION 'contract: a refused submit with no detail was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%trade_invoice_events_submit_refused_detail%' THEN RAISE; END IF;
  END;

  -- 4. It never carries bank or pay fields.
  BEGIN
    INSERT INTO public.trade_invoice_events (trade_invoice_id, event_type, actor, detail)
    VALUES (NULL, 'submit_refused', 'trade:x',
      '{"user_id":"u","action":"generate_trade_invoice","http_status":409,"bsb":"000-000"}');
    RAISE EXCEPTION 'contract: a refused submit carrying a bank field was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%trade_invoice_events_submit_refused_detail%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.trade_invoice_events (trade_invoice_id, event_type, actor, detail)
    VALUES (NULL, 'submit_refused', 'trade:x',
      '{"user_id":"u","action":"generate_trade_invoice","http_status":409,"net_pay":1}');
    RAISE EXCEPTION 'contract: a refused submit carrying a pay field was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%trade_invoice_events_submit_refused_detail%' THEN RAISE; END IF;
  END;

  -- 5. The table is still closed to unknown types and still append-only.
  BEGIN
    INSERT INTO public.trade_invoice_events (trade_invoice_id, event_type, actor)
    VALUES (gen_random_uuid(), 'anything_else', 'x');
    RAISE EXCEPTION 'contract: an unknown event type was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM public.trade_invoice_events WHERE id = '00000000-0000-4000-8000-0000000000f1';
    RAISE EXCEPTION 'contract: a refused submit record was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.trade_invoice_events SET reason = 'x' WHERE id = '00000000-0000-4000-8000-0000000000f1';
    RAISE EXCEPTION 'contract: a refused submit record was updated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- 6. Still service role only.
  IF has_table_privilege('anon', 'public.trade_invoice_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trade_invoice_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trade_invoice_events', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.trade_invoice_events', 'INSERT')
     OR has_table_privilege('service_role', 'public.trade_invoice_events', 'UPDATE')
     OR has_table_privilege('service_role', 'public.trade_invoice_events', 'DELETE') THEN
    RAISE EXCEPTION 'contract: trade_invoice_events grants changed';
  END IF;
  IF to_regclass('public.trade_invoice_events_submit_refused_idx') IS NULL THEN
    RAISE EXCEPTION 'contract: the refused-submit index is missing';
  END IF;
END $$;
ROLLBACK;
