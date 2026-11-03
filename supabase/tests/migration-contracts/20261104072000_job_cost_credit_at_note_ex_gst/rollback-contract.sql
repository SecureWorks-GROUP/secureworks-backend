-- After the down: v_job_cost_events is back to its exact earlier definition, the objects 20261104072000 added are gone, and the
-- cost view still reads.
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '8f9de7093e1998941320e088eab39ff0' THEN
    RAISE EXCEPTION 'A6 rollback 20261104072000: v_job_cost_events is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
  IF to_regprocedure('public.job_cost_credit_ex(numeric,text,text)') IS NOT NULL THEN RAISE EXCEPTION 'A6 rollback 20261104072000: job_cost_credit_ex is still there'; END IF;
  IF to_regprocedure('public.job_cost_credit_note_part_ex(numeric,numeric,text,text)') IS NOT NULL THEN RAISE EXCEPTION 'A6 rollback 20261104072000: job_cost_credit_note_part_ex is still there'; END IF;
  PERFORM count(*) FROM public.v_job_cost_events;
END $$;
