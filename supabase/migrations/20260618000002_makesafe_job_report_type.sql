-- Add report_type column to makesafe_job_details.
-- Nullable; set when approveIntakeDraft creates a job for a report-only draft
-- (roof_report / assessment_report). Normal WO jobs leave this null.
ALTER TABLE public.makesafe_job_details
  ADD COLUMN IF NOT EXISTS report_type text;
