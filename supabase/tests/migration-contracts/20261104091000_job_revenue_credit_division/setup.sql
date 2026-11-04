-- Prerequisites for 20261104091000_job_revenue_credit_division: 20261104090000 (its function), applied by the registered walk.
DO $$
BEGIN
  IF to_regprocedure('public.job_cost_document_business_unit(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'A3 credit division: 20261104090000 is not applied before 20261104091000';
  END IF;
END $$;
