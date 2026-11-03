-- After the down: v_job_cost_events is back to its exact earlier definition, the objects 20261104071000 added are gone, and the
-- cost view still reads.
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '32c422a8d90aecf6924fc0a84d4569fe' THEN
    RAISE EXCEPTION 'A6 rollback 20261104071000: v_job_cost_events is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
  IF to_regprocedure('public.job_cost_super_withheld_line(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'A6 rollback 20261104071000: job_cost_super_withheld_line is still there'; END IF;
  IF to_regprocedure('public.job_cost_super_company_contribution(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'A6 rollback 20261104071000: job_cost_super_company_contribution is still there'; END IF;
  PERFORM count(*) FROM public.v_job_cost_events;
END $$;
