-- ════════════════════════════════════════════════════════════
-- Migration 013: Assignment Time Tracking
--
-- Adds started_at / completed_at timestamps to job_assignments
-- so trades can clock in/out and the office sees labour hours.
-- ════════════════════════════════════════════════════════════

ALTER TABLE job_assignments
  ADD COLUMN IF NOT EXISTS started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Must drop + recreate view to add new columns (can't reorder with CREATE OR REPLACE)
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
