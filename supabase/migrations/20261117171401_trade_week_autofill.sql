-- P1-16.1: retain the suggestion beside the sent week. Both switches ship off.
-- Existing rows remain unknown except auto_sent, whose legacy value is false.

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('trade_week_autofill_v1', false,
   'The week''s invoice is filled in by the system from bookings, the clock and work orders; the trade accepts or changes it. Rate and GST come from the records.'),
  ('trade_week_auto_send_v1', false,
   'A fully clocked, untouched week is sent by the system on Sunday night, with a notice and a way to reopen. Owner''s yes only.')
ON CONFLICT (flag_name) DO NOTHING;

ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS suggested jsonb,
  ADD COLUMN IF NOT EXISTS changed_from_suggestion boolean;

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS accepted_untouched boolean,
  ADD COLUMN IF NOT EXISTS confirm_seconds integer
    CONSTRAINT trade_invoices_confirm_seconds_check
    CHECK (confirm_seconds IS NULL OR (confirm_seconds >= 0 AND confirm_seconds <= 86400)),
  ADD COLUMN IF NOT EXISTS auto_sent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS office_sent_back_at timestamptz;

