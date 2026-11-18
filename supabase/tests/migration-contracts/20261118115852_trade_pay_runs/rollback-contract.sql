-- After the down migration: the record, its function, the three invoice
-- columns and the switch are gone; trade_invoices and P1-08.3 remain.
DO $$
BEGIN
  IF to_regclass('public.trade_pay_runs') IS NOT NULL OR to_regclass('public.trade_pay_run_invoices') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST pay run tables survived the rollback';
  END IF;
  IF to_regprocedure('public.approve_trade_pay_run(uuid,date,uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST approve function survived the rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.trade_invoices'::regclass AND NOT attisdropped
             AND attname IN ('pay_run_id','reviewed_at','reviewed_by')) THEN
    RAISE EXCEPTION 'ZZTEST invoice columns survived the rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'trade_pay_run_v1') THEN
    RAISE EXCEPTION 'ZZTEST switch survived the rollback';
  END IF;
  IF to_regprocedure('public.trade_pay_run_standing_checks(uuid,uuid[],text)') IS NULL THEN
    RAISE EXCEPTION 'ZZTEST rollback removed P1-08.3';
  END IF;
  PERFORM count(*) FROM public.trade_invoices;
END $$;
\echo 'PASS: P1-10.1 rollback.'
