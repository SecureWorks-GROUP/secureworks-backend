-- Rollback for 20261120143000_trade_invoice_office_submitted_event: restores
-- the five-type event check. The event store is append-only, so this refuses
-- while any 'office_submitted' row exists rather than deleting audit rows.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $office_submitted_down$
DECLARE
  v_definition text;
  v_before constant text := 'CHECK ((event_type = ANY (ARRAY[''voided_bill_released''::text, ''stuck_invoice_resolved''::text, ''xero_bill_reused''::text, ''extra_rate_held''::text, ''receipt_released''::text])))';
  v_after constant text := 'CHECK ((event_type = ANY (ARRAY[''voided_bill_released''::text, ''stuck_invoice_resolved''::text, ''xero_bill_reused''::text, ''extra_rate_held''::text, ''receipt_released''::text, ''office_submitted''::text])))';
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_definition
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = to_regclass('public.trade_invoice_events')
    AND c.conname = 'trade_invoice_events_type_check';
  IF v_definition = v_before THEN
    RETURN; -- rolled back already
  END IF;
  IF v_definition IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'trade_invoice_events_type_check is not this migration''s: %', coalesce(v_definition, '(missing)');
  END IF;
  IF EXISTS (SELECT 1 FROM public.trade_invoice_events WHERE event_type = 'office_submitted') THEN
    RAISE EXCEPTION 'office_submitted events exist; the append-only store keeps them, so the check cannot narrow';
  END IF;
  ALTER TABLE public.trade_invoice_events DROP CONSTRAINT trade_invoice_events_type_check;
  ALTER TABLE public.trade_invoice_events ADD CONSTRAINT trade_invoice_events_type_check
    CHECK (event_type IN ('voided_bill_released','stuck_invoice_resolved',
      'xero_bill_reused','extra_rate_held','receipt_released'));
END $office_submitted_down$;
