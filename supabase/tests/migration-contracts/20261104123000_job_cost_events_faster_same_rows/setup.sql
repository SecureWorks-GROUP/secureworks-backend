-- Prerequisites for 20261104123000_job_cost_events_faster_same_rows: the cost view and the supplier credit allocations
-- as the registered walk leaves them (20261104090000 and 20261030060000).
DO $$
BEGIN
  IF to_regprocedure('public.job_cost_crew_bill_line_job_number(text)') IS NULL THEN
    RAISE EXCEPTION 'C3 cost view speed: 20261104090000 is not applied before 20261104123000';
  END IF;
  IF to_regclass('public.v_supplier_credit_allocations') IS NULL THEN
    RAISE EXCEPTION 'C3 cost view speed: 20261030060000 is not applied before 20261104123000';
  END IF;
END $$;
