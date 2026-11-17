DO $$ BEGIN
 IF to_regprocedure('public.reject_trade_invoice_v1(uuid,text)') IS NOT NULL
   OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.trade_invoice_lines_one_receipt'::regclass AND indisunique) THEN
  RAISE EXCEPTION 'FU17 rollback did not remove only its callable';
 END IF;
END $$;
SELECT 'PASS: FU17 rollback leaves permanent receipt uniqueness' AS result;
