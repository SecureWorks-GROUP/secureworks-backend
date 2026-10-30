-- Prerequisites for 20261029170100_context_job_bill_outcomes: CFO's outcome
-- view (20261029170000) and the tables it names. Adds nothing.
DO $$
BEGIN
  IF to_regclass('public.cfo_bill_cost_outcomes') IS NULL THEN
    RAISE EXCEPTION 'context bill outcomes setup: cfo_bill_cost_outcomes missing from the registered stack';
  END IF;
END $$;
