DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'trade_invoice_lines'
        AND column_name IN ('hold_reason', 'held_at')) THEN
    RAISE EXCEPTION 'ZZTEST hold columns were not removed';
  END IF;
END $$;
