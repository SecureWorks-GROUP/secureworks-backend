-- ============================================================
-- Migration: crew_availability table + job_assignments enhancements
-- Run in Supabase SQL Editor
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. CREW AVAILABILITY TABLE
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crew_availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        date NOT NULL,
  status      text NOT NULL CHECK (status IN ('available', 'unavailable', 'leave')),
  note        text,
  created_at  timestamptz DEFAULT now(),

  UNIQUE(user_id, date)
);

-- Index for date range queries (calendar view)
CREATE INDEX idx_crew_avail_user_date ON crew_availability(user_id, date);
CREATE INDEX idx_crew_avail_date ON crew_availability(date);

-- RLS
ALTER TABLE crew_availability ENABLE ROW LEVEL SECURITY;

-- Users can read all availability (needed for ops calendar)
CREATE POLICY "Users can view all availability"
  ON crew_availability FOR SELECT
  USING (true);

-- Users can manage their own availability
CREATE POLICY "Users can manage own availability"
  ON crew_availability FOR ALL
  USING (user_id = auth.uid());

-- Service role can manage all
CREATE POLICY "Service role manages availability"
  ON crew_availability FOR ALL
  USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- 2. JOB ASSIGNMENTS — new fields for confirmation workflow
-- ────────────────────────────────────────────────────────────
ALTER TABLE job_assignments
  ADD COLUMN IF NOT EXISTS confirmation_status text DEFAULT 'tentative'
    CHECK (confirmation_status IN ('tentative', 'confirmed', 'declined')),
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS crew_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS duration_days integer DEFAULT 1;
