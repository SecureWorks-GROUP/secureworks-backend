BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'trade_invoice_lines'
        AND column_name IN ('hold_reason', 'held_at')
        AND is_nullable = 'YES' AND column_default IS NULL) <> 2 THEN
    RAISE EXCEPTION 'ZZTEST hold columns must be nullable without defaults';
  END IF;
END $$;
ROLLBACK;
