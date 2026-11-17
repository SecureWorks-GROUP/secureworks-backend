DO $$ BEGIN
  IF to_regprocedure('public.job_work_order_gaps(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST gap reader was not removed';
  END IF;
END $$;
