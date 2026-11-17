-- Earlier registered cases supply bookings, users, feature_flags and API roles.
-- Model the existing lead flag and unique booking key, not a new product change.
ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS is_lead boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.job_assignments'::regclass
      AND conname = 'job_assignments_job_user_date_key') THEN
    ALTER TABLE public.job_assignments ADD CONSTRAINT job_assignments_job_user_date_key
      UNIQUE(job_id, user_id, scheduled_date);
  END IF;
END $$;
