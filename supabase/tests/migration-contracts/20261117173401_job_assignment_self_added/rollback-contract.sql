DO $$ BEGIN
  IF to_regprocedure('public.trade_is_off_job_crew(uuid,uuid,date)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'job_assignments'
        AND column_name IN ('added_by', 'self_added_status', 'self_added_at',
          'self_added_reviewed_by', 'self_added_reviewed_at', 'self_added_review_note')) THEN
    RAISE EXCEPTION 'ZZTEST self-added schema survived rollback';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.job_assignments'::regclass
      AND conname = 'job_assignments_job_user_date_key') THEN
    RAISE EXCEPTION 'ZZTEST original booking key was removed';
  END IF;
END $$;
