DO $$ BEGIN
  IF to_regprocedure('public.reject_trade_invoice_v1(uuid,text)') IS NULL
     OR to_regclass('public.trade_invoice_events') IS NULL THEN
    RAISE EXCEPTION 'FU22 rejection and event store prerequisites missing';
  END IF;
END $$;
-- The original timer-invoice migration is not a registered prerequisite.
-- Reproduce its historical index for the local query-plan proof.
CREATE INDEX IF NOT EXISTS idx_inv_lines_invoice ON public.trade_invoice_lines(trade_invoice_id);
