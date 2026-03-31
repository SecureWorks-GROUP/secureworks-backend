-- ════════════════════════════════════════════════════════════
-- Migration: Add clock/timer fields to calendar_events view
-- Enables ops dashboard to show live "on site" indicators
-- and clock-on/off times for crew assignments
-- ════════════════════════════════════════════════════════════

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
  ja.confirmation_status,
  ja.confirmed_at,
  ja.crew_name,
  ja.notes AS assignment_notes,
  ja.started_at,
  ja.completed_at,
  ja.job_phase,
  ja.last_phase_changed_at,
  ja.duration_days,
  -- Clock/timer fields (new)
  ja.clocked_on_at,
  ja.clocked_off_at,
  ja.travel_started_at,
  ja.arrived_at,
  ja.break_minutes,
  ja.hours_worked,
  -- Job fields
  j.type AS job_type,
  j.job_number,
  j.client_name,
  j.client_phone,
  j.site_address,
  j.site_suburb,
  j.status AS job_status,
  j.org_id,
  j.ghl_contact_id,
  j.pricing_json,
  j.scope_json,
  j.legacy,
  -- User fields
  u.name AS assigned_to,
  u.phone AS assigned_phone,
  -- Xero fields
  xp.project_name AS xero_project_name,
  xp.total_invoiced AS xero_invoiced,
  xp.total_expenses AS xero_expenses
FROM job_assignments ja
JOIN jobs j ON j.id = ja.job_id
LEFT JOIN users u ON u.id = ja.user_id
LEFT JOIN xero_projects xp ON xp.job_id = ja.job_id;
