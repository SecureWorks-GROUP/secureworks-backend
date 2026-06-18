-- Add report_type column to makesafe_intake_drafts.
-- Nullable; only set on report-capture drafts (re-attend / roof report /
-- temp fence / assessment). Normal new-WO drafts leave this null.
ALTER TABLE public.makesafe_intake_drafts
  ADD COLUMN IF NOT EXISTS report_type text;
