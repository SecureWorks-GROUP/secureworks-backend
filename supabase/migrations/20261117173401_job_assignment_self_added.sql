-- P1-16.11: record self-added bookings without changing existing crew rules.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('trade_self_add_v1', false,
  'A trade can add themselves to a live job they were not booked on. The booking is marked as added by the trade and shown to the office and the crew lead.')
ON CONFLICT (flag_name) DO NOTHING;

ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS added_by text NOT NULL DEFAULT 'office'
    CHECK (added_by IN ('office', 'self')),
  ADD COLUMN IF NOT EXISTS self_added_status text
    CHECK (self_added_status IS NULL OR self_added_status IN ('added', 'accepted', 'not_accepted')),
  ADD COLUMN IF NOT EXISTS self_added_at timestamptz,
  ADD COLUMN IF NOT EXISTS self_added_reviewed_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS self_added_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS self_added_review_note text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.job_assignments'::regclass
      AND conname = 'job_assignments_self_added_shape') THEN
    ALTER TABLE public.job_assignments
      ADD CONSTRAINT job_assignments_self_added_shape
      CHECK ((added_by = 'self') = (self_added_status IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.job_assignments'::regclass
      AND conname = 'job_assignments_self_added_not_lead') THEN
    ALTER TABLE public.job_assignments
      ADD CONSTRAINT job_assignments_self_added_not_lead
      CHECK (added_by <> 'self' OR is_lead = false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS job_assignments_self_added_idx
  ON public.job_assignments (self_added_at) WHERE added_by = 'self';

-- The existing (job_id, user_id, scheduled_date) unique key bounds this read.
CREATE OR REPLACE FUNCTION public.trade_is_off_job_crew(
  p_user_id uuid, p_job_id uuid, p_week_start date
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  SELECT coalesce(bool_or(a.added_by = 'self' AND a.self_added_status = 'not_accepted'), false)
    AND NOT coalesce(bool_or(a.added_by = 'office' OR a.self_added_status = 'accepted'), false)
  FROM public.job_assignments a
  WHERE a.job_id = p_job_id AND a.user_id = p_user_id
    AND a.scheduled_date BETWEEN p_week_start AND p_week_start + 6
    AND a.status <> 'cancelled';
$$;

REVOKE ALL ON FUNCTION public.trade_is_off_job_crew(uuid, uuid, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_is_off_job_crew(uuid, uuid, date) TO service_role;
