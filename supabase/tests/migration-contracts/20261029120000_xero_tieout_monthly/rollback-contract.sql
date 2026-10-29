-- After the down: the tie-out function is gone and the tables it read are
-- untouched and still queryable.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regprocedure('public.xero_tieout_monthly(date,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: xero_tieout_monthly remains';
  END IF;
  PERFORM 1 FROM public.xero_invoices LIMIT 1;
  PERFORM 1 FROM public.job_materials_facts LIMIT 1;
  PERFORM 1 FROM public.materials_reconciliation_queue LIMIT 1;
  PERFORM 1 FROM public.xero_bank_transactions LIMIT 1;
  PERFORM 1 FROM public.v_bill_allocation_balance LIMIT 1;
END $$;
