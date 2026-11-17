-- The registered stack owns these existing tables and the two-argument body.
DO $$ BEGIN
  IF to_regclass('public.trade_invoice_events') IS NULL
     OR to_regprocedure('public.reject_trade_invoice_v1(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'cx-reimb-rest rejection prerequisites missing';
  END IF;
END $$;
