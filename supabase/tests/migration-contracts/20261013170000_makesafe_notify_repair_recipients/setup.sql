-- Contract fixture for 20261013170000_makesafe_notify_repair_recipients.sql.
-- makesafe_notify_settings is restated in its live shape (read from production
-- information_schema on 13 Oct 2026) with its one row; no earlier case makes
-- it. The phone arrays are left empty on purpose: this fixture carries no
-- phone number. public.users is owned by an earlier case and restated only in
-- case that case is removed. Test infrastructure, not the production schema.
CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  name text NOT NULL,
  role text,
  managed_verticals text[] DEFAULT ARRAY[]::text[]
);

CREATE TABLE IF NOT EXISTS public.makesafe_notify_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  notify_enabled boolean NOT NULL DEFAULT true,
  alarm_enabled boolean NOT NULL DEFAULT true,
  arrival_general_phones text[] NOT NULL DEFAULT ARRAY[]::text[],
  arrival_roof_phones text[] NOT NULL DEFAULT ARRAY[]::text[],
  alarm_phones text[] NOT NULL DEFAULT ARRAY[]::text[],
  from_number text NOT NULL DEFAULT '+61000000000',
  updated_at timestamptz NOT NULL DEFAULT now(),
  d1_reconcile_enabled boolean NOT NULL DEFAULT false
);

INSERT INTO public.makesafe_notify_settings (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;
