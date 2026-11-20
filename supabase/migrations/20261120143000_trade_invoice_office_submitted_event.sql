-- The office (or the ops agent naming a staff person) can submit a trade's
-- invoice through the trade's own submit path (ops-api
-- office_generate_trade_invoice, office_trade_invoice.ts). Each such invoice
-- gets one append-only trade_invoice_events row, event_type
-- 'office_submitted', naming the office person and the reason. This widens
-- the event type check by that one value and changes nothing else: no column,
-- no trigger, no function, no grant.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $office_submitted$
DECLARE
  v_definition text;
  v_before constant text := 'CHECK ((event_type = ANY (ARRAY[''voided_bill_released''::text, ''stuck_invoice_resolved''::text, ''xero_bill_reused''::text, ''extra_rate_held''::text, ''receipt_released''::text])))';
  v_after constant text := 'CHECK ((event_type = ANY (ARRAY[''voided_bill_released''::text, ''stuck_invoice_resolved''::text, ''xero_bill_reused''::text, ''extra_rate_held''::text, ''receipt_released''::text, ''office_submitted''::text])))';
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_definition
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = to_regclass('public.trade_invoice_events')
    AND c.conname = 'trade_invoice_events_type_check';
  IF v_definition = v_after THEN
    RETURN; -- applied already
  END IF;
  -- Any other list means another lane moved the check: stop rather than drop
  -- an event type this migration does not know about.
  IF v_definition IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'trade_invoice_events_type_check preimage changed: %', coalesce(v_definition, '(missing)');
  END IF;
  ALTER TABLE public.trade_invoice_events DROP CONSTRAINT trade_invoice_events_type_check;
  ALTER TABLE public.trade_invoice_events ADD CONSTRAINT trade_invoice_events_type_check
    CHECK (event_type IN ('voided_bill_released','stuck_invoice_resolved',
      'xero_bill_reused','extra_rate_held','receipt_released','office_submitted'));
END $office_submitted$;
