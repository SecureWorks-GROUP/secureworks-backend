-- After the down migration the three objects are production's definitions from before 20261104200500.
DO $$
BEGIN
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)) <> 'bd4fe36c7035eb3a6e28f4be2bebafca' THEN
    RAISE EXCEPTION 'A2 credits rollback: job_profit_line_evidence_many is not the earlier definition';
  END IF;
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)) <> 'd869f2e39cd71685d86a473e395e751e' THEN
    RAISE EXCEPTION 'A2 credits rollback: job_profit_line_evidence_score is not the earlier definition';
  END IF;
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> 'ac6290aedfe4477b40a6235a7e71d45e' THEN
    RAISE EXCEPTION 'A2 credits rollback: v_job_profit is not the earlier definition';
  END IF;
  IF (SELECT m.result ->> 'rule' FROM public.job_profit_line_evidence_many(ARRAY[gen_random_uuid()]) m) <> 'r57-v3' THEN
    RAISE EXCEPTION 'A2 credits rollback: the earlier rule label r57-v3 is not back';
  END IF;
END $$;
