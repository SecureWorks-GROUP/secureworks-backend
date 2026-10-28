-- Minimal pre-migration surface for 20261028150000_reschedule_job_assignments.
-- Earlier registered cases already create public.users, public.jobs,
-- public.job_assignments, public.job_events and public.trade_invoices (and the
-- anon, authenticated and service_role roles); this restates only what the
-- function reads or writes, in its live shape, in case no earlier case made
-- it. Test infrastructure, not a replacement for the production schema.
CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS role text;

CREATE TABLE IF NOT EXISTS public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS job_number text;

CREATE TABLE IF NOT EXISTS public.trade_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS subtotal_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS gst numeric(12,2),
  ADD COLUMN IF NOT EXISTS total_inc numeric(12,2),
  ADD COLUMN IF NOT EXISTS gst_on boolean,
  ADD COLUMN IF NOT EXISTS super_rate numeric(7,6),
  ADD COLUMN IF NOT EXISTS super_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS gross_earned numeric(12,2),
  ADD COLUMN IF NOT EXISTS net_pay numeric(12,2);

CREATE TABLE IF NOT EXISTS public.job_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_events
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS detail_json jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.job_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
-- Live job_assignments.id defaults to gen_random_uuid(); one earlier case
-- created the table without that default.
ALTER TABLE public.job_assignments ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS role text DEFAULT 'lead_installer',
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS scheduled_date date,
  ADD COLUMN IF NOT EXISTS scheduled_end date,
  ADD COLUMN IF NOT EXISTS duration_days integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS start_time time,
  ADD COLUMN IF NOT EXISTS end_time time,
  ADD COLUMN IF NOT EXISTS assignment_type text DEFAULT 'install',
  ADD COLUMN IF NOT EXISTS crew_name text,
  ADD COLUMN IF NOT EXISTS confirmation_status text DEFAULT 'tentative',
  ADD COLUMN IF NOT EXISTS invoiced_in uuid,
  ADD COLUMN IF NOT EXISTS visible_to_trades boolean,
  ADD COLUMN IF NOT EXISTS attendance_cycle_id uuid,
  ADD COLUMN IF NOT EXISTS cycle_attribution text,
  ADD COLUMN IF NOT EXISTS is_ghost boolean NOT NULL DEFAULT false;

-- Live carries this unique key on (job_id, user_id, scheduled_date) with no
-- status or ghost exemption; the function names it when it refuses.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'job_assignments_job_user_date_key'
  ) THEN
    ALTER TABLE public.job_assignments
      ADD CONSTRAINT job_assignments_job_user_date_key UNIQUE (job_id, user_id, scheduled_date);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
