-- Local booking_test fences. Not production. No cluster/role changes.

ALTER TABLE sales_booking_cases
  ADD COLUMN IF NOT EXISTS accepted_end_iso text,
  ADD COLUMN IF NOT EXISTS accepted_slot_revision integer,
  ADD COLUMN IF NOT EXISTS accepted_resource_id text;

CREATE TABLE IF NOT EXISTS sales_booking_slot_claims (
  claim_id text PRIMARY KEY,
  resource_id text NOT NULL,
  start_iso text NOT NULL,
  end_iso text NOT NULL,
  case_id text NOT NULL,
  status text NOT NULL DEFAULT 'held',
  withdrawn boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_booking_slot_claims_live
  ON sales_booking_slot_claims (resource_id, start_iso, end_iso)
  WHERE withdrawn = false;

CREATE TABLE IF NOT EXISTS sales_booking_leases (
  lease_id text PRIMARY KEY,
  case_id text NOT NULL,
  action_kind text NOT NULL,
  token text NOT NULL UNIQUE,
  owner text NOT NULL,
  expires_at timestamptz NOT NULL,
  released boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_booking_source_revisions (
  case_id text PRIMARY KEY,
  calendar_revision text,
  conversation_revision text,
  leave_revision text,
  observed_at timestamptz NOT NULL DEFAULT now()
);
