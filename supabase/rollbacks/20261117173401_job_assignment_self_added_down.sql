-- Never erase the provenance or decision on a self-added booking.
LOCK TABLE public.job_assignments IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.job_assignments WHERE added_by = 'self') THEN
    RAISE EXCEPTION 'self_added_bookings_exist';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.trade_is_off_job_crew(uuid, uuid, date);
DROP INDEX IF EXISTS public.job_assignments_self_added_idx;
ALTER TABLE public.job_assignments
  DROP CONSTRAINT IF EXISTS job_assignments_self_added_shape,
  DROP CONSTRAINT IF EXISTS job_assignments_self_added_not_lead,
  DROP COLUMN IF EXISTS self_added_review_note,
  DROP COLUMN IF EXISTS self_added_reviewed_at,
  DROP COLUMN IF EXISTS self_added_reviewed_by,
  DROP COLUMN IF EXISTS self_added_at,
  DROP COLUMN IF EXISTS self_added_status,
  DROP COLUMN IF EXISTS added_by;
DELETE FROM public.feature_flags WHERE flag_name = 'trade_self_add_v1';
