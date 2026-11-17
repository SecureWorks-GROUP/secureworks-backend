DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.trade_invoice_lines'::regclass AND conname='trade_invoice_lines_hold_reason_check')
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='trade_invoice_lines' AND column_name='hold_reason') THEN
    RAISE EXCEPTION 'ZZTEST hold reason rollback did not preserve the existing column';
  END IF;
END $$;
