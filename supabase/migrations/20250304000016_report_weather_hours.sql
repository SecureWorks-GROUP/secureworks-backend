-- ════════════════════════════════════════════════════════════
-- Add weather, hours, and variations tracking to service reports
-- Used by Trade app for richer completion reports
-- ════════════════════════════════════════════════════════════

ALTER TABLE job_service_reports
  ADD COLUMN IF NOT EXISTS weather text,
  ADD COLUMN IF NOT EXISTS start_time text,
  ADD COLUMN IF NOT EXISTS end_time text,
  ADD COLUMN IF NOT EXISTS variations text;

COMMENT ON COLUMN job_service_reports.weather IS 'Weather condition during job (sunny/overcast/rain/hot/windy)';
COMMENT ON COLUMN job_service_reports.start_time IS 'Work start time (HH:MM format)';
COMMENT ON COLUMN job_service_reports.end_time IS 'Work end time (HH:MM format)';
COMMENT ON COLUMN job_service_reports.variations IS 'Free text describing any variations or issues encountered';
