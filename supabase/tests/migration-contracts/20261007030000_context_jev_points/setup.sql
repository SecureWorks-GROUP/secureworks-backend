-- Prerequisites for 20261007030000_context_jev_points. The Jev log
-- (20261006080000) and the records its truth read reads (business_events,
-- jobs, job_assignments, visit_outcomes, context_linked_status,
-- context_job_record_date) come from earlier registered cases; this adds the
-- one column none of them needs, job_assignments.verified_at (live in
-- production), and proves no point's switch exists yet.
ALTER TABLE public.job_assignments ADD COLUMN IF NOT EXISTS verified_at timestamptz;
DO $$
BEGIN
 IF to_regclass('public.context_jev_decisions') IS NULL THEN
  RAISE EXCEPTION 'jev points setup: the Jev log (20261006080000) is missing from the registered stack';
 END IF;
 IF to_regclass('public.visit_outcomes') IS NULL OR to_regprocedure('public.context_linked_status(text)') IS NULL
  OR to_regprocedure('public.context_job_record_date(text)') IS NULL THEN
  RAISE EXCEPTION 'jev points setup: a record the truth read reads is missing from the registered stack';
 END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name LIKE 'context_jev_point_%') THEN
  RAISE EXCEPTION 'jev points setup: a point''s switch exists before the migration';
 END IF;
END $$;
