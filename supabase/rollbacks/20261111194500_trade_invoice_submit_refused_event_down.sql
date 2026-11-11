-- Down for 20261111194500_trade_invoice_submit_refused_event.
-- Puts trade_invoice_events back to its four event types with an invoice id
-- on every row. The refused-submit rows cannot stay under those rules, so
-- they are removed: copy them out first if they are still wanted.
--   COPY (SELECT * FROM public.trade_invoice_events WHERE event_type = 'submit_refused') TO STDOUT;
-- Every other event, and every invoice, is untouched.
ALTER TABLE public.trade_invoice_events DISABLE TRIGGER trg_trade_invoice_events_append_only;
DELETE FROM public.trade_invoice_events WHERE event_type = 'submit_refused';
ALTER TABLE public.trade_invoice_events ENABLE TRIGGER trg_trade_invoice_events_append_only;

DROP INDEX IF EXISTS public.trade_invoice_events_submit_refused_idx;
ALTER TABLE public.trade_invoice_events
  DROP CONSTRAINT IF EXISTS trade_invoice_events_submit_refused_detail;
ALTER TABLE public.trade_invoice_events
  DROP CONSTRAINT IF EXISTS trade_invoice_events_invoice_required;
ALTER TABLE public.trade_invoice_events
  ALTER COLUMN trade_invoice_id SET NOT NULL;
ALTER TABLE public.trade_invoice_events
  DROP CONSTRAINT IF EXISTS trade_invoice_events_type_check;
ALTER TABLE public.trade_invoice_events
  ADD CONSTRAINT trade_invoice_events_type_check CHECK (event_type IN (
    'voided_bill_released',
    'stuck_invoice_resolved',
    'xero_bill_reused',
    'extra_rate_held'
  ));
