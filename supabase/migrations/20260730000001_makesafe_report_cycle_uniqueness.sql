CREATE UNIQUE INDEX IF NOT EXISTS uq_job_service_reports_attendance_cycle
  ON public.job_service_reports (attendance_cycle_id)
  WHERE attendance_cycle_id IS NOT NULL;
