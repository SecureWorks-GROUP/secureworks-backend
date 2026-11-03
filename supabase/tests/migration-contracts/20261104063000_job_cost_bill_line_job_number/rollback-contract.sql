-- After the down: production's 20261103224500 cost view and the old bill outcomes are back, the text reader and the
-- switch are gone, and the cost view still reads.
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '7f7837be26bf12f131bd86c84ab6ea55' THEN
    RAISE EXCEPTION 'bill line job number rollback: v_job_cost_events is not the 20261103224500 definition';
  END IF;
  IF md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure)) <> 'e60aed71c96970715cc8df4b77925f0a' THEN
    RAISE EXCEPTION 'bill line job number rollback: cfo_bill_cost_outcomes_scoped is not the old definition';
  END IF;
  IF to_regprocedure('public.job_cost_bill_line_job_id(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'bill line job number rollback: job_cost_bill_line_job_id is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_cost_installer_line_job_number_v1') THEN
    RAISE EXCEPTION 'bill line job number rollback: the switch is still there';
  END IF;
  PERFORM count(*) FROM public.v_job_cost_events;
END $$;
