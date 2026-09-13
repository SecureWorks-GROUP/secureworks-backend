-- Isolated booking_test. Per-action / per-stage journal. Not production.
ALTER TABLE sales_booking_actions ADD COLUMN IF NOT EXISTS stage text;
ALTER TABLE sales_booking_actions ADD COLUMN IF NOT EXISTS source_version text;
ALTER TABLE sales_booking_actions ADD COLUMN IF NOT EXISTS provider_uncertain boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS sales_booking_action_journal (
  id text PRIMARY KEY,
  org_id uuid NOT NULL,
  action_id text NOT NULL,
  stage text NOT NULL,
  actor_id text,
  detail jsonb,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_booking_action_journal_action
  ON sales_booking_action_journal (org_id, action_id, at);

REVOKE ALL ON TABLE sales_booking_action_journal FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE sales_booking_action_journal TO service_role, marninstobbe;
GRANT ALL ON TABLE sales_booking_actions TO marninstobbe;
