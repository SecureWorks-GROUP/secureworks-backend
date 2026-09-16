-- ════════════════════════════════════════════════════════════
-- Migration: Add job_family to calendar_events view
--
-- Exposes a job's SES/make-safe FAMILY on the calendar feed so the
-- OpsDash calendar's Divisions filter can recognise family-tagged
-- repairs the same way the Repairs board (loadInsuranceRepairJobIds,
-- insurance_repairs_board.ts) and make-safe board (excludeInsuranceRepairs)
-- already do.
--
-- `update_makesafe_job_family` deliberately never retypes `jobs.type`
-- (SWR- mint is a one-way supervised door, ruling 2026-08-28), so a
-- job can be family-tagged 'repair' while jobs.type stays 'makesafe'
-- (or, historically, 'fencing') permanently by design. Prior to this
-- migration calendar_events.job_type was COALESCE(j.type, ja.job_type)
-- alone, so such a card filed under its birth division on the
-- calendar's new Divisions filter while correctly appearing under
-- Repairs elsewhere. See
-- data/repair-pipeline-type-audit-scout/report.md (outside this repo)
-- for the full diagnosis.
--
-- Contract for consumers (see AGENTS.md "Calendar feed job_family"):
-- job_family is present on every calendar event row; value 'repair'
-- means "treat as Repair division regardless of job_type"; null or
-- anything else means fall back to job_type.
--
-- This migration is additive and idempotent (CREATE OR REPLACE VIEW)
-- and safe to auto-deploy: it changes no data and adds one column.
--
-- Based on the LIVE view definition (confirmed via pg_get_viewdef on
-- 2026-09-16), which has drifted ahead of the last migration that
-- declared this view (20260330000001_calendar_clock_fields.sql) per
-- AGENTS.md's documented calendar_events drift note. Live carries
-- LEFT JOIN jobs (not JOIN), a COALESCE org_id, an is_ghost filter,
-- and three extra job_assignments columns (label, visible_to_trades,
-- recurrence_group_id) not in that migration file. All of that is
-- preserved verbatim below; only job_family is new.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW calendar_events AS
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
  -- Clock/timer fields
  ja.clocked_on_at,
  ja.clocked_off_at,
  ja.travel_started_at,
  ja.arrived_at,
  ja.break_minutes,
  ja.hours_worked,
  -- Job fields
  COALESCE(j.type, ja.job_type) AS job_type,
  j.job_number,
  j.client_name,
  j.client_phone,
  j.site_address,
  j.site_suburb,
  j.status AS job_status,
  COALESCE(j.org_id, ja.org_id) AS org_id,
  j.ghl_contact_id,
  j.pricing_json,
  j.scope_json,
  j.legacy,
  -- Family (new): SES/make-safe family tag, independent of jobs.type.
  -- 'repair' here means "this is repair-shaped work" even when jobs.type
  -- was never retyped. Narrow projected keys only, never the metadata blob.
  COALESCE(j.metadata->>'ses_family', j.metadata->>'makesafe_job_family') AS job_family,
  -- User fields
  u.name AS assigned_to,
  u.phone AS assigned_phone,
  -- Xero fields
  xp.project_name AS xero_project_name,
  xp.total_invoiced AS xero_invoiced,
  xp.total_expenses AS xero_expenses,
  ja.label,
  ja.visible_to_trades,
  ja.recurrence_group_id
FROM job_assignments ja
LEFT JOIN jobs j ON j.id = ja.job_id
LEFT JOIN users u ON u.id = ja.user_id
LEFT JOIN xero_projects xp ON xp.job_id = ja.job_id
WHERE ja.is_ghost = false;
