DO $$ BEGIN
  IF to_regprocedure('public.install_trade_repayment_save_lock()') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.trade_invoices'::regclass AND tgname='trade_repayment_save_lock') THEN
    RAISE EXCEPTION 'ZZTEST repayment lock rollback incomplete'; END IF;
END $$;
