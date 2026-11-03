-- After the down: v_job_cost_events is back to its exact earlier definition, the objects 20261104070000 added are gone, and the
-- cost view still reads.
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '7f7837be26bf12f131bd86c84ab6ea55' THEN
    RAISE EXCEPTION 'A6 rollback 20261104070000: v_job_cost_events is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
  IF to_regprocedure('public.bookkeeping_evidence_add_parts(text,text,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'A6 rollback 20261104070000: the parts load is still there'; END IF;
  IF to_regclass('public.v_bookkeeping_line_parts_current') IS NOT NULL THEN RAISE EXCEPTION 'A6 rollback 20261104070000: the parts view is still there'; END IF;
  IF to_regclass('public.bookkeeping_line_evidence_parts') IS NOT NULL THEN RAISE EXCEPTION 'A6 rollback 20261104070000: the empty parts table is still there'; END IF;
  PERFORM count(*) FROM public.v_job_cost_events;
END $$;
