DO $$ BEGIN
 IF strpos(pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure), '-- FU12: release only')>0 THEN RAISE EXCEPTION 'FU12 release survived rollback'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.trade_invoice_lines_one_receipt'::regclass AND indisunique) THEN RAISE EXCEPTION 'FU12 rollback removed permanent uniqueness'; END IF;
END $$;
SELECT 'PASS: FU12 rollback preserves permanent receipt uniqueness' AS result;
