-- Isolated booking_test. Authoritative conversation capture receipts. Not production.
CREATE TABLE IF NOT EXISTS sales_booking_conversation_captures (
  capture_id text PRIMARY KEY,
  org_id uuid NOT NULL,
  case_id text NOT NULL,
  contact_id text NOT NULL,
  source_version text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  cutoff_at text,
  content_hash text NOT NULL,
  messages jsonb NOT NULL,
  has_more boolean NOT NULL DEFAULT false,
  retrieved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_booking_conversation_captures_case
  ON sales_booking_conversation_captures (org_id, case_id, source_version, captured_at DESC);
REVOKE ALL ON TABLE sales_booking_conversation_captures FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE sales_booking_conversation_captures TO service_role, marninstobbe;
