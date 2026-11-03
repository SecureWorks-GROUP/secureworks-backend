-- After the down: v_job_cost_events is back to its exact earlier definition, the functions 20261104090000 added are
-- gone, and the cost view still reads.
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '366599ce55b0e0430d45ee9e6e04c315' THEN
    RAISE EXCEPTION 'A3 rollback 20261104090000: v_job_cost_events is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
  IF to_regprocedure('public.job_cost_line_business_unit(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'A3 rollback 20261104090000: job_cost_line_business_unit is still there'; END IF;
  IF to_regprocedure('public.job_cost_bill_business_unit(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'A3 rollback 20261104090000: job_cost_bill_business_unit is still there'; END IF;
  IF to_regprocedure('public.job_cost_crew_bill_line_job_number(text)') IS NOT NULL THEN RAISE EXCEPTION 'A3 rollback 20261104090000: job_cost_crew_bill_line_job_number is still there'; END IF;
  PERFORM count(*) FROM public.v_job_cost_events;
END $$;
