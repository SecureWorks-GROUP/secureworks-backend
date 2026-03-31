-- ════════════════════════════════════════════════════════════
-- Migration: Job Phase Tracking
--
-- Adds job_phase to job_assignments so trade execution state
-- is persisted server-side (not just localStorage).
-- Ops can see where each tradie is. AI layer gets phase events.
-- ════════════════════════════════════════════════════════════

-- Phase column — assignment-level execution state
ALTER TABLE job_assignments
  ADD COLUMN IF NOT EXISTS job_phase text DEFAULT 'assigned'
    CHECK (job_phase IN ('assigned','acknowledged','travelling','arrived','materials_check','working','wrap_up','complete')),
  ADD COLUMN IF NOT EXISTS last_phase_changed_at timestamptz;

-- Index for ops dashboard queries (e.g. "show all currently travelling")
CREATE INDEX IF NOT EXISTS idx_job_assignments_phase
  ON job_assignments (job_phase)
  WHERE job_phase NOT IN ('assigned', 'complete');

-- Recreate calendar_events view to include job_phase
DROP VIEW IF EXISTS calendar_events;

CREATE VIEW calendar_events AS
SELECT
  ja.id AS assignment_id,
  ja.job_id,
  ja.user_id,
  ja.scheduled_date,
  ja.scheduled_end,
  ja.start_time,
  ja.end_time,
  ja.assignment_type,
  ja.status AS assignment_status,
  ja.job_phase,
  ja.last_phase_changed_at,
  ja.crew_name,
  ja.notes AS assignment_notes,
  ja.started_at,
  ja.completed_at,
  j.type AS job_type,
  j.client_name,
  j.client_phone,
  j.site_address,
  j.site_suburb,
  j.status AS job_status,
  j.org_id,
  j.ghl_contact_id,
  j.pricing_json,
  u.name AS assigned_to,
  u.phone AS assigned_phone,
  xp.project_name AS xero_project_name,
  xp.total_invoiced AS xero_invoiced,
  xp.total_expenses AS xero_expenses
FROM job_assignments ja
JOIN jobs j ON j.id = ja.job_id
LEFT JOIN users u ON u.id = ja.user_id
LEFT JOIN xero_projects xp ON xp.job_id = ja.job_id;
