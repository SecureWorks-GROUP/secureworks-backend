-- Slice 4 — Smart Booking
-- scoper_preferences: per-scoper preference profile for JARVIS smart-booking
-- WHO/WHERE/WHEN scoring. Approved at Checkpoint B 2026-05-04.
--
-- This file is the canonical record of what was applied via Supabase
-- migration 20260505010113_scoper_preferences. Keep in sync if amended.
--
-- Reproducibility note: the seed block at the bottom uses WHERE EXISTS so
-- a fresh `supabase db reset` against an empty auth.users does not crash
-- on FK violation. In production those auth.users rows exist, so the
-- inserts land. In a fresh local stack with no users yet, the inserts
-- silently skip. ON CONFLICT (user_id) DO NOTHING keeps it idempotent.

CREATE TABLE IF NOT EXISTS scoper_preferences (
  user_id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name          text NOT NULL,
  home_suburb        text,
  home_lat           numeric(9,6),
  home_lng           numeric(9,6),
  available_days     int[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::int[],
  daily_window       jsonb NOT NULL DEFAULT jsonb_build_object('start','08:00','end','16:30'),
  lunch_window       jsonb,
  max_drive_km       int  NOT NULL DEFAULT 60,
  preferred_suburbs  text[] NOT NULL DEFAULT ARRAY[]::text[],
  blackout_suburbs   text[] NOT NULL DEFAULT ARRAY[]::text[],
  google_calendar_id text,
  calendar_link      text,
  per_lane           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  scoper_preferences IS
  'One row per scoping operator. Drives JARVIS smart-booking WHO/WHERE/WHEN scoring.';
COMMENT ON COLUMN scoper_preferences.available_days IS 'ISO weekdays 1=Mon..7=Sun.';
COMMENT ON COLUMN scoper_preferences.daily_window  IS 'jsonb { start: "HH:MM", end: "HH:MM" } Australia/Perth.';
COMMENT ON COLUMN scoper_preferences.lunch_window  IS 'jsonb { start, end } or NULL if no fixed lunch block.';
COMMENT ON COLUMN scoper_preferences.per_lane      IS 'jsonb keyed by lane slug (fencing|patios). enabled/max_drive_km/weight/reason.';

CREATE INDEX IF NOT EXISTS idx_scoper_pref_preferred_suburbs
  ON scoper_preferences USING GIN (preferred_suburbs);
CREATE INDEX IF NOT EXISTS idx_scoper_pref_blackout_suburbs
  ON scoper_preferences USING GIN (blackout_suburbs);
CREATE INDEX IF NOT EXISTS idx_scoper_pref_per_lane
  ON scoper_preferences USING GIN (per_lane jsonb_path_ops);

CREATE OR REPLACE FUNCTION set_scoper_preferences_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_scoper_preferences_updated_at ON scoper_preferences;
CREATE TRIGGER trg_scoper_preferences_updated_at
  BEFORE UPDATE ON scoper_preferences
  FOR EACH ROW EXECUTE FUNCTION set_scoper_preferences_updated_at();

ALTER TABLE scoper_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read scoper_preferences"
  ON scoper_preferences FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Scoper can update own preferences"
  ON scoper_preferences FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Service role manages scoper_preferences"
  ON scoper_preferences FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Seed roster — only inserts for auth.users that actually exist in this DB.
-- Production has all three; a fresh local reset has none, and the SELECT
-- simply returns zero rows.
INSERT INTO scoper_preferences (
  user_id, full_name, home_suburb, home_lat, home_lng,
  available_days, daily_window, lunch_window,
  max_drive_km, preferred_suburbs, blackout_suburbs,
  google_calendar_id, calendar_link, per_lane
)
SELECT
  v.user_id::uuid, v.full_name, v.home_suburb, v.home_lat, v.home_lng,
  v.available_days, v.daily_window, v.lunch_window,
  v.max_drive_km, v.preferred_suburbs, v.blackout_suburbs,
  v.google_calendar_id, v.calendar_link, v.per_lane
FROM (VALUES
  ('be6c2188-2b7b-49c7-b6e4-5b0d0deb6415',
   'Khairo Pomare', 'Quinns Rocks', -31.6717::numeric, 115.7000::numeric,
   ARRAY[1,2,3,4,5]::int[],
   jsonb_build_object('start','08:00','end','16:30'),
   jsonb_build_object('start','12:00','end','12:30'),
   60, ARRAY[]::text[], ARRAY[]::text[], NULL::text, NULL::text,
   jsonb_build_object(
     'fencing', jsonb_build_object('enabled', true,  'weight', 1.0),
     'patios',  jsonb_build_object('enabled', false, 'reason', 'fencing-only')
   )),
  ('706c5258-70dd-483a-b36c-af6864b24498',
   'Marnin Stobbe', 'Joondalup', -31.7448::numeric, 115.7661::numeric,
   ARRAY[1,2,3,4,5]::int[],
   jsonb_build_object('start','08:00','end','17:00'),
   jsonb_build_object('start','12:00','end','12:45'),
   80, ARRAY[]::text[], ARRAY[]::text[], NULL::text, NULL::text,
   jsonb_build_object(
     'fencing', jsonb_build_object('enabled', true, 'weight', 0.6),
     'patios',  jsonb_build_object('enabled', true, 'weight', 0.6)
   )),
  ('5862cf1d-0a3b-4836-8fd1-d69f95aa2f73',
   'Nithin', 'Heathridge', -31.7833::numeric, 115.7833::numeric,
   ARRAY[1,2,3,4,5]::int[],
   jsonb_build_object('start','08:00','end','16:30'),
   jsonb_build_object('start','12:00','end','12:30'),
   60, ARRAY[]::text[], ARRAY[]::text[], NULL::text, NULL::text,
   jsonb_build_object(
     'fencing', jsonb_build_object('enabled', false, 'reason', 'patio-only'),
     'patios',  jsonb_build_object('enabled', true,  'weight', 1.0)
   ))
) AS v(
  user_id, full_name, home_suburb, home_lat, home_lng,
  available_days, daily_window, lunch_window,
  max_drive_km, preferred_suburbs, blackout_suburbs,
  google_calendar_id, calendar_link, per_lane
)
WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = v.user_id::uuid)
ON CONFLICT (user_id) DO NOTHING;
