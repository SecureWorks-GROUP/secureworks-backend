-- Prerequisites for 20261104235000_job_profit_xero_basis_division_months: the Job Profit engine and the A3 and A6 cost
-- rules before it, applied by the registered walk (the view reads their rows and functions).
DO $$
BEGIN
  IF to_regclass('public.v_job_cost_events') IS NULL OR to_regclass('public.v_job_revenue_events') IS NULL
     OR to_regclass('public.v_job_profit') IS NULL OR to_regclass('public.v_bookkeeping_line_evidence_current') IS NULL
     OR to_regclass('public.v_bookkeeping_line_parts_current') IS NULL OR to_regclass('public.xero_supplier_credit_notes') IS NULL
     OR to_regclass('public.xero_supplier_credit_note_allocations') IS NULL
     OR to_regprocedure('public.job_cost_document_business_unit(jsonb)') IS NULL
     OR to_regprocedure('public.job_cost_line_business_unit(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'A3 Xero basis: the Job Profit engine or the A3 division rule (20261104090000) is not applied before 20261104235000';
  END IF;
END $$;
