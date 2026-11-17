DO $$ BEGIN
 IF to_regprocedure('public.job_backed_room(uuid)') IS NOT NULL
 OR to_regprocedure('public.trade_invoice_lines_job_amount_guard()') IS NOT NULL
 OR to_regprocedure('public.install_trade_line_job_amount_guard()') IS NOT NULL
 OR to_regprocedure('public.remove_trade_line_job_amount_guard()') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trade_invoice_lines_job_amount_guard'
   AND tgrelid='public.trade_invoice_lines'::regclass) THEN
  RAISE EXCEPTION 'ZZTEST amount guard rollback incomplete';
 END IF;
END $$;
SELECT 'ZZTEST P1-05.9 rollback passed' AS result;
