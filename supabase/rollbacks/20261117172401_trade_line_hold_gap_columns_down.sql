-- Roll back the gap reader first. Never discard a recorded hold.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE hold_reason IS NOT NULL OR held_at IS NOT NULL) THEN
    RAISE EXCEPTION 'trade line hold columns contain evidence';
  END IF;
END $$;
ALTER TABLE public.trade_invoice_lines
  DROP COLUMN held_at,
  DROP COLUMN hold_reason;
