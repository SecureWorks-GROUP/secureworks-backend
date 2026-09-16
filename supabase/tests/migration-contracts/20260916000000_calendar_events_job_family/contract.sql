-- Executed against disposable PostgreSQL after the migration.
BEGIN;

-- 1. The view carries exactly the live 44 columns plus job_family, LAST.
DO $$
DECLARE
  actual text[];
  expected text[] := ARRAY[
    'assignment_id', 'job_id', 'user_id', 'scheduled_date', 'scheduled_end',
    'start_time', 'end_time', 'assignment_type', 'assignment_status',
    'confirmation_status', 'confirmed_at', 'crew_name', 'assignment_notes',
    'started_at', 'completed_at', 'job_phase', 'last_phase_changed_at',
    'duration_days', 'clocked_on_at', 'clocked_off_at', 'travel_started_at',
    'arrived_at', 'break_minutes', 'hours_worked', 'job_type', 'job_number',
    'client_name', 'client_phone', 'site_address', 'site_suburb', 'job_status',
    'org_id', 'ghl_contact_id', 'pricing_json', 'scope_json', 'legacy',
    'assigned_to', 'assigned_phone', 'xero_project_name', 'xero_invoiced',
    'xero_expenses', 'label', 'visible_to_trades', 'recurrence_group_id',
    'job_family'
  ];
BEGIN
  SELECT array_agg(column_name::text ORDER BY ordinal_position)
  INTO actual
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'calendar_events';

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'calendar_events column set drifted: got % expected %',
      actual, expected;
  END IF;
END;
$$;

INSERT INTO public.users (id, org_id, name, role) VALUES
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000aa', 'Calendar trade', 'trade');

INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata) VALUES
  -- family-tagged repair: jobs.type deliberately stays makesafe
  ('c2000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000aa',
   'processing', 'makesafe', 'SWMS-CALFAM-REPAIR', '{"ses_family": "repair"}'::jsonb),
  -- plain make-safe with no family metadata
  ('c2000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-0000000000aa',
   'processing', 'makesafe', 'SWMS-CALFAM-PLAIN', '{}'::jsonb);

INSERT INTO public.job_assignments (id, job_id, user_id, status, scheduled_date, role) VALUES
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001', 'scheduled', '2026-09-17', 'lead_installer'),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002',
   'c1000000-0000-4000-8000-000000000001', 'scheduled', '2026-09-17', 'lead_installer');

-- 2. A make-safe row tagged ses_family=repair projects job_family = 'repair'.
DO $$
DECLARE
  family text;
BEGIN
  SELECT job_family INTO family
  FROM public.calendar_events
  WHERE assignment_id = 'c5000000-0000-4000-8000-000000000001';

  IF family IS DISTINCT FROM 'repair' THEN
    RAISE EXCEPTION 'family-tagged repair projected job_family % (expected repair)', family;
  END IF;
END;
$$;

-- 3. A plain make-safe row projects job_family NULL and job_type unchanged.
DO $$
DECLARE
  family text;
  jtype text;
BEGIN
  SELECT job_family, job_type INTO family, jtype
  FROM public.calendar_events
  WHERE assignment_id = 'c5000000-0000-4000-8000-000000000002';

  IF family IS NOT NULL THEN
    RAISE EXCEPTION 'plain make-safe projected job_family % (expected NULL)', family;
  END IF;
  IF jtype IS DISTINCT FROM 'makesafe' THEN
    RAISE EXCEPTION 'plain make-safe projected job_type % (expected makesafe)', jtype;
  END IF;
END;
$$;

ROLLBACK;
