DO $$ BEGIN
 IF to_regprocedure('public.job_cost_lines_sync_trade_invoice(uuid)') IS NOT NULL
   OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname LIKE 'job_cost_lines_trade_%')
   OR to_regclass('public.v_trade_charge_resolved') IS NULL THEN RAISE EXCEPTION 'trade sync rollback failed'; END IF;
END $$;
