-- Contract fixture for 20261013110000_repair_intake_auto_flag.sql.
-- Only feature_flags is restated, in its live shape (read from production
-- information_schema on 13 Oct 2026), in case no earlier case made it.
-- Test infrastructure, not a replacement for the production schema.
CREATE TABLE IF NOT EXISTS public.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  description text,
  updated_at timestamptz DEFAULT now()
);
