-- Minimal pre-migration surface for the calendar_events job_family contract.
-- public.jobs, public.users and public.job_assignments already exist from
-- earlier registered cases; everything below is additive. The pre-migration
-- view is created here in its LIVE 44-column shape (read from production via
-- pg_get_viewdef on 2026-09-16) so the migration's CREATE OR REPLACE VIEW is
-- exercised against the real pre-existing column order: Postgres refuses any
-- new column that is not appended last, which a text check cannot see.
-- Test infrastructure, not a replacement for the production schema.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS client_phone text,
  ADD COLUMN IF NOT EXISTS ghl_contact_id text,
  ADD COLUMN IF NOT EXISTS pricing_json jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS scope_json jsonb DEFAULT '{}'::jsonb;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS phone text;

ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS scheduled_end date,
  ADD COLUMN IF NOT EXISTS start_time time,
  ADD COLUMN IF NOT EXISTS end_time time,
  ADD COLUMN IF NOT EXISTS assignment_type text DEFAULT 'install',
  ADD COLUMN IF NOT EXISTS confirmation_status text DEFAULT 'tentative',
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS crew_name text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS job_phase text DEFAULT 'assigned',
  ADD COLUMN IF NOT EXISTS last_phase_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS duration_days integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS clocked_on_at timestamptz,
  ADD COLUMN IF NOT EXISTS clocked_off_at timestamptz,
  ADD COLUMN IF NOT EXISTS travel_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS break_minutes integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hours_worked numeric(6,2),
  ADD COLUMN IF NOT EXISTS job_type text,
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS visible_to_trades boolean,
  ADD COLUMN IF NOT EXISTS recurrence_group_id uuid,
  ADD COLUMN IF NOT EXISTS is_ghost boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.xero_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES public.jobs(id),
  project_name text,
  total_invoiced numeric,
  total_expenses numeric
);

CREATE OR REPLACE VIEW public.calendar_events AS
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
