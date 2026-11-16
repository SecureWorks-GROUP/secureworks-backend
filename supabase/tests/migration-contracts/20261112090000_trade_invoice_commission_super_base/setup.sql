-- The registered stack supplies crew invoices with the money split.
DO $$ BEGIN
  IF to_regclass('public.trade_invoices') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'trade_invoices' AND column_name = 'net_pay'
     ) THEN
    RAISE EXCEPTION 'trade invoice money split prerequisites are missing';
  END IF;
END $$;
