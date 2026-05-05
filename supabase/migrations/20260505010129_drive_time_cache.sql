-- Slice 4 — Smart Booking
-- drive_time_cache: memoised AU postcode-to-postcode drive time/distance.
-- 30-day TTL enforced in app code (booking-loop / maps util) via cached_at.
-- Approved at Checkpoint B 2026-05-04.
--
-- This file is the canonical record of what was applied via Supabase
-- migration 20260505010129_drive_time_cache. Keep in sync if amended.

CREATE TABLE IF NOT EXISTS drive_time_cache (
  origin_postcode  text        NOT NULL,
  dest_postcode    text        NOT NULL,
  drive_seconds    int         NOT NULL,
  distance_meters  int         NOT NULL,
  cached_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (origin_postcode, dest_postcode),

  CONSTRAINT drive_time_cache_origin_format CHECK (origin_postcode ~ '^[0-9]{4}$'),
  CONSTRAINT drive_time_cache_dest_format   CHECK (dest_postcode   ~ '^[0-9]{4}$'),
  CONSTRAINT drive_time_cache_seconds_nonneg CHECK (drive_seconds   >= 0),
  CONSTRAINT drive_time_cache_meters_nonneg  CHECK (distance_meters >= 0)
);

COMMENT ON TABLE  drive_time_cache IS
  'Memoised Google Routes drive-time results between AU postcodes. Application enforces 30-day TTL via cached_at.';
COMMENT ON COLUMN drive_time_cache.cached_at IS
  '30-day TTL enforced in app code (smart-booking maps util). Rows older than 30d are treated as cache miss.';
COMMENT ON COLUMN drive_time_cache.drive_seconds IS
  'Best-effort one-way drive time in seconds. Direction matters (origin -> dest); reverse pair stored separately.';

CREATE INDEX IF NOT EXISTS idx_drive_time_cache_cached_at
  ON drive_time_cache (cached_at);
CREATE INDEX IF NOT EXISTS idx_drive_time_cache_dest
  ON drive_time_cache (dest_postcode);

ALTER TABLE drive_time_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read drive_time_cache"
  ON drive_time_cache FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role manages drive_time_cache"
  ON drive_time_cache FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
