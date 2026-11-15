-- After the down migration the check is gone and the tables it read are untouched.
DO $$
BEGIN
  IF to_regprocedure('public.trade_pay_run_check(date,integer,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: trade_pay_run_check still exists';
  END IF;
  PERFORM 1 FROM public.trade_invoices LIMIT 1;
  PERFORM 1 FROM public.trade_invoice_lines LIMIT 1;
END $$;
