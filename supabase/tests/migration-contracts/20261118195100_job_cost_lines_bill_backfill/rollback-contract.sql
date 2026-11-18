-- After the rollback: the four functions are gone.
DO $$
BEGIN
  IF to_regprocedure('public.job_cost_lines_backfill_bills(uuid,date,date,integer,date,text)') IS NOT NULL
     OR to_regprocedure('public.job_cost_lines_bill_document(uuid,jsonb,boolean)') IS NOT NULL
     OR to_regprocedure('public.job_cost_bill_json(double precision)') IS NOT NULL
     OR to_regprocedure('public.job_cost_bill_number(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'twin rollback: a function is still there';
  END IF;
END;
$$;
