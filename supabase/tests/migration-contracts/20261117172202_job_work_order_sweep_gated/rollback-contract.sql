DO $contract$ BEGIN
  IF position('sweep_gate_' in pg_get_functiondef('public.trigger_job_work_order_auto_issue()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'rollback retained the gate';
  END IF;
END $contract$;
