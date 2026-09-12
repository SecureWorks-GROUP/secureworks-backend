-- Sales Booking durable workflow records.
-- Isolated branch only. Not applied to production by this mission.
-- Booking consumes CIO context; this is not a second provider-memory system.

CREATE TABLE IF NOT EXISTS sales_booking_cases (
  id text PRIMARY KEY,
  resource_id text NOT NULL,
  opportunity_id text,
  contact_id text,
  pipeline_id text,
  suburb text,
  display_name text,
  status text NOT NULL DEFAULT 'needs_decision',
  exact_acceptance boolean NOT NULL DEFAULT false,
  accepted_offer_id text,
  accepted_start_iso text,
  event_id text,
  send_evidence text,
  completed boolean NOT NULL DEFAULT false,
  source_version text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_booking_drafts (
  case_id text PRIMARY KEY REFERENCES sales_booking_cases(id),
  text text,
  revision integer NOT NULL DEFAULT 0,
  human_edited boolean NOT NULL DEFAULT false,
  sender text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_booking_offers (
  offer_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES sales_booking_cases(id),
  message_id text,
  slot_revision integer NOT NULL DEFAULT 1,
  start_iso text NOT NULL,
  end_iso text,
  send_evidence text NOT NULL DEFAULT 'held',
  sent_at timestamptz
);

CREATE TABLE IF NOT EXISTS sales_booking_actions (
  action_id text PRIMARY KEY,
  case_id text NOT NULL,
  kind text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  send_evidence text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_booking_archives (
  case_id text PRIMARY KEY,
  reason text NOT NULL,
  note text,
  restored boolean NOT NULL DEFAULT false,
  contact_id text,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_booking_assessments (
  case_id text PRIMARY KEY,
  version text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_booking_cursors (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_booking_seen_events (
  event_key text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE sales_booking_cases IS 'Booking workflow cases. Not a GHL/Outlook mirror.';
