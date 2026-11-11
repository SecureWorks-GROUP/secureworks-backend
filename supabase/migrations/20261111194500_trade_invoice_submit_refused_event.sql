-- A refused or failed trade invoice submit leaves a record.
--
-- trade_invoice_events (20261106163712) is the append-only record of what
-- happened to a trade invoice outside the normal submit flow. Until now a
-- submit the server refused, or one that failed, left nothing behind: no
-- invoice row and no event, so the office could not see that a trade had
-- tried to invoice and been turned away, or why.
--
-- This adds one event type, 'submit_refused', to the same table. Such a submit
-- usually has no invoice row, so trade_invoice_id may be empty for this type
-- only. The row says who (the trade's user id), which door, which week, the
-- HTTP status and the refusal code and message the trade was shown. It never
-- holds bank or pay details: the writer copies none, and the check below
-- refuses the keys that would carry them.
--
-- ops-api writes the row through its one event writer, which logs and carries
-- on when the insert is refused, so ops-api running ahead of this migration
-- loses the record but never changes what the trade is told.
--
-- No explicit transaction: the apply lane runs each migration in its own.

ALTER TABLE public.trade_invoice_events
  DROP CONSTRAINT IF EXISTS trade_invoice_events_type_check;
ALTER TABLE public.trade_invoice_events
  ADD CONSTRAINT trade_invoice_events_type_check CHECK (event_type IN (
    'voided_bill_released',
    'stuck_invoice_resolved',
    'xero_bill_reused',
    'extra_rate_held',
    'submit_refused'
  ));

-- Every other event is about an invoice that exists. A refused submit names
-- one only when the refusal pointed at one (the week's existing invoice).
ALTER TABLE public.trade_invoice_events
  ALTER COLUMN trade_invoice_id DROP NOT NULL;
ALTER TABLE public.trade_invoice_events
  DROP CONSTRAINT IF EXISTS trade_invoice_events_invoice_required;
ALTER TABLE public.trade_invoice_events
  ADD CONSTRAINT trade_invoice_events_invoice_required CHECK (
    trade_invoice_id IS NOT NULL OR event_type = 'submit_refused'
  );

-- A refused submit always says who, which door and what the answer was, and
-- never carries bank or pay fields.
ALTER TABLE public.trade_invoice_events
  DROP CONSTRAINT IF EXISTS trade_invoice_events_submit_refused_detail;
ALTER TABLE public.trade_invoice_events
  ADD CONSTRAINT trade_invoice_events_submit_refused_detail CHECK (
    event_type <> 'submit_refused'
    OR (
      detail ? 'user_id'
      AND detail ? 'action'
      AND detail ? 'http_status'
      AND NOT (detail ?| ARRAY[
        'bsb', 'account_no', 'accountNo', 'account_name', 'accountName', 'abn',
        'rate', 'hourly_rate', 'unit_rate', 'gross_earned', 'net_pay',
        'super_amount', 'gst', 'total_inc', 'trade_payable', 'lines',
        'extra_items', 'manual_assignments'
      ])
    )
  );

CREATE INDEX IF NOT EXISTS trade_invoice_events_submit_refused_idx
  ON public.trade_invoice_events (created_at DESC)
  WHERE event_type = 'submit_refused';

COMMENT ON CONSTRAINT trade_invoice_events_invoice_required ON public.trade_invoice_events IS
  'Only a refused submit (submit_refused) may have no invoice: it usually never became one.';
