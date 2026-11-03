-- After the down: v_job_cost_events and v_supplier_credit_allocations are back to their exact earlier definitions, the
-- index is gone, and both views still read.
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> 'abdc05a69d139d79aebbb8a3cebfae03' THEN
    RAISE EXCEPTION 'C3 rollback 20261104123000: v_job_cost_events is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
  IF md5(pg_get_viewdef('public.v_supplier_credit_allocations'::regclass, true)) <> '0000749040d6b72e63bf77a4318cf293' THEN
    RAISE EXCEPTION 'C3 rollback 20261104123000: v_supplier_credit_allocations is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_supplier_credit_allocations'::regclass, true));
  END IF;
  IF to_regclass('public.xero_invoices_xero_invoice_id_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'C3 rollback 20261104123000: xero_invoices_xero_invoice_id_idx is still there';
  END IF;
  PERFORM count(*) FROM public.v_job_cost_events;
  PERFORM count(*) FROM public.v_supplier_credit_allocations;
END $$;
