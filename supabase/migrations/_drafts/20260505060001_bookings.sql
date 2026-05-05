-- Slice 4 — Smart Booking, handshake v2 (CP-I)
-- Two new tables for the booking handshake state machine:
--   * bookings        — one row per attempted handshake (per opportunity)
--   * bookings_events — append-only audit timeline
--
-- The handshake produces 0-2 ai_proposed_actions rows per booking
-- (M1 + M2). Cross-references stored on the bookings row.
--
-- DRAFT — not applied. Awaits explicit Marnin migration approval.

-- ────────────────────────────────────────────────────────────
-- 1. BOOKINGS
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bookings (
  booking_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source links. opportunity_id is GHL-side text (matches existing
  -- patterns); job_id is the linked Supabase job (nullable — handshake
  -- can begin before a job row exists, but most bookings will have one).
  opportunity_id        text NOT NULL,
  job_id                uuid REFERENCES jobs(id) ON DELETE SET NULL,
  contact_id            text,
  lane                  text NOT NULL CHECK (lane IN ('fencing', 'patio')),

  -- State machine (see contract block at bottom). Transitions are append
  -- to bookings_events, not silent updates.
  state                 text NOT NULL DEFAULT 'created'
    CHECK (state IN (
      'created',
      'awaiting_customer_windows',
      'windows_received',
      'awaiting_customer_confirmation',
      'confirmed',
      'calendar_written',
      'cancelled',
      'declined',
      'parse_clarification_needed'
    )),

  -- Planning + handshake content
  candidate_windows     jsonb,           -- JARVIS's initial steer
  customer_windows      jsonb,           -- parsed from customer reply (M1)
  picked_slot           jsonb,           -- { start_iso, end_iso, scoper_user_id, drive_minutes, distance_meters }
  scoper_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Calendar write outcome
  google_calendar_event_id  text,        -- populated on successful write
  google_calendar_calendar_id text,      -- which scoper's calendar (impersonation target)

  -- Cross-references to ai_proposed_actions rows (each handshake produces
  -- 0-2 proposals; clarification-path proposals not counted here).
  m1_proposal_id        uuid,
  m2_proposal_id        uuid,

  -- Cancellation / decline / parse failure context
  cancellation_reason   text,
  parse_failure_count   int NOT NULL DEFAULT 0,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- One active handshake at a time per opportunity. A previous booking
  -- cancelled / declined / done can coexist with a new one but only one
  -- in any non-terminal state.
  CONSTRAINT bookings_picked_slot_shape CHECK (
    picked_slot IS NULL OR (
      picked_slot ? 'start_iso' AND picked_slot ? 'end_iso' AND picked_slot ? 'scoper_user_id'
    )
  )
);

COMMENT ON TABLE bookings IS
  'JARVIS booking handshake state. One row per attempted handshake. State machine transitions append to bookings_events.';
COMMENT ON COLUMN bookings.state IS
  'See state machine in handshake plan. Terminal states: calendar_written, cancelled, declined.';
COMMENT ON COLUMN bookings.picked_slot IS
  'jsonb { start_iso, end_iso, scoper_user_id, drive_minutes?, distance_meters? } populated after step 4 planning pass.';
COMMENT ON COLUMN bookings.google_calendar_event_id IS
  'Calendar event id returned by Google after successful insert. Used for follow-up / cancellation in v2.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bookings_opportunity_id  ON bookings (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_bookings_job_id          ON bookings (job_id);
CREATE INDEX IF NOT EXISTS idx_bookings_contact_id      ON bookings (contact_id);
CREATE INDEX IF NOT EXISTS idx_bookings_state           ON bookings (state) WHERE state NOT IN ('calendar_written','cancelled','declined');
CREATE INDEX IF NOT EXISTS idx_bookings_scoper_user_id  ON bookings (scoper_user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_lane            ON bookings (lane);
CREATE INDEX IF NOT EXISTS idx_bookings_picked_slot     ON bookings USING GIN (picked_slot jsonb_path_ops);

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_bookings_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;
CREATE TRIGGER trg_bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_bookings_updated_at();

-- RLS
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read bookings"
  ON bookings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages bookings"
  ON bookings FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ────────────────────────────────────────────────────────────
-- 2. BOOKINGS_EVENTS (append-only audit)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bookings_events (
  event_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  event_type   text NOT NULL CHECK (event_type IN (
    'created',
    'm1_drafted',
    'm1_approved',
    'm1_sent',
    'customer_windows_received',
    'customer_windows_parse_failed',
    'planning_pass_succeeded',
    'planning_pass_no_match',
    'm2_drafted',
    'm2_approved',
    'm2_sent',
    'customer_confirmed',
    'customer_declined',
    'customer_alternate',
    'calendar_write_attempted',
    'calendar_write_succeeded',
    'calendar_write_failed',
    'cancellation_recorded',
    'clarification_drafted'
  )),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE bookings_events IS
  'Append-only audit timeline for each booking. Every state transition emits at least one row here.';

CREATE INDEX IF NOT EXISTS idx_bookings_events_booking_id_at
  ON bookings_events (booking_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_events_event_type
  ON bookings_events (event_type);

ALTER TABLE bookings_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read bookings_events"
  ON bookings_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role appends bookings_events"
  ON bookings_events FOR INSERT TO public WITH CHECK (auth.role() = 'service_role');
-- Intentionally NO update/delete policy. Audit rows are append-only.

-- ────────────────────────────────────────────────────────────
-- State machine contract (documentation only — enforced by app code)
-- ────────────────────────────────────────────────────────────
--
-- created
--   -> awaiting_customer_windows           (after m1_approved + m1_sent)
--
-- awaiting_customer_windows
--   -> windows_received                    (after customer reply parses)
--   -> parse_clarification_needed          (after parse fail; clarification SMS drafted per 6a)
--
-- parse_clarification_needed
--   -> awaiting_customer_windows           (after clarification SMS sent + reply received)
--   -> cancelled                           (after N parse failures or human cancel)
--
-- windows_received
--   -> awaiting_customer_confirmation      (after planning pass picks a slot + m2_approved + m2_sent)
--   -> cancelled                           (planning pass found no matching slot AND human cancelled)
--
-- awaiting_customer_confirmation
--   -> confirmed                           (after customer reply parses as 'yes')
--   -> declined                            (after customer reply parses as 'no')
--   -> windows_received                    (after customer reply parses as 'alternate' — re-plan)
--
-- confirmed
--   -> calendar_written                    (after Google Calendar insert succeeds)
--
-- calendar_written / cancelled / declined  TERMINAL
