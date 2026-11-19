-- The registered stack owns the reject body (20261117235501, stamped by
-- 20261118153104) and trade_invoices.pay_run_id (20261118115852).
DO $$ BEGIN
  IF to_regprocedure('public.reject_trade_invoice_v1(uuid,text,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.trade_invoices'::regclass
       AND attname = 'pay_run_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'reject pay run prerequisites missing';
  END IF;
END $$;
