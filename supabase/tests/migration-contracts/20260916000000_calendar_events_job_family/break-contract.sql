-- Meta-test: deliberately remove the promise this migration makes (the
-- job_family column), so ../run.sh can prove contract.sql detects a view that
-- was never widened.
DROP VIEW public.calendar_events;
CREATE VIEW public.calendar_events AS
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
  ja.clocked_on_at,
  ja.clocked_off_at,
  ja.travel_started_at,
  ja.arrived_at,
  ja.break_minutes,
  ja.hours_worked,
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
  u.name AS assigned_to,
  u.phone AS assigned_phone,
  xp.project_name AS xero_project_name,
  xp.total_invoiced AS xero_invoiced,
  xp.total_expenses AS xero_expenses,
  ja.label,
  ja.visible_to_trades,
  ja.recurrence_group_id
FROM public.job_assignments ja
LEFT JOIN public.jobs j ON j.id = ja.job_id
LEFT JOIN public.users u ON u.id = ja.user_id
LEFT JOIN public.xero_projects xp ON xp.job_id = ja.job_id
WHERE ja.is_ghost = false;
