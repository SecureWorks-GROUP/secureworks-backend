-- Prerequisites for 20261104071000_job_cost_xero_crew_bill_super: the A6 cost rules before it, applied by the registered walk.
DO $$
BEGIN
  IF to_regclass('public.v_bookkeeping_line_parts_current') IS NULL OR to_regclass('public.contract_a6_preimage') IS NULL THEN
    RAISE EXCEPTION 'A6 cost rules: 20261104070000 is not applied before 20261104071000';
  END IF;
END $$;
