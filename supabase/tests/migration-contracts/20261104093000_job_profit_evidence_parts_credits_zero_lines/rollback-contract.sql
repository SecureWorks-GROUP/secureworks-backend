-- After the down migration both functions are production's definitions from before 20261104093000.
DO $$
BEGIN
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)) <> 'fa520b9d6721716868c5f2048a367ae5' THEN
    RAISE EXCEPTION 'A2 rollback: job_profit_line_evidence_many is not the earlier definition';
  END IF;
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)) <> '669fe32f975cb22739d8d941e8b61b52' THEN
    RAISE EXCEPTION 'A2 rollback: job_profit_line_evidence_score is not the earlier definition';
  END IF;
  IF (SELECT m.result ->> 'rule' FROM public.job_profit_line_evidence_many(ARRAY[gen_random_uuid()]) m) <> 'r57-v2' THEN
    RAISE EXCEPTION 'A2 rollback: the earlier rule label r57-v2 is not back';
  END IF;
END $$;
