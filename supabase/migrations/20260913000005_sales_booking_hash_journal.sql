ALTER TABLE sales_booking_assessments ADD COLUMN IF NOT EXISTS source_hash text;
CREATE INDEX IF NOT EXISTS sales_booking_assessments_source_hash ON sales_booking_assessments (org_id, source_hash);

CREATE TABLE IF NOT EXISTS sales_booking_runner_journal (
  id text PRIMARY KEY,
  org_id uuid NOT NULL,
  case_id text,
  kind text NOT NULL,
  status text NOT NULL,
  detail jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_booking_runner_journal_org_at ON sales_booking_runner_journal (org_id, at DESC);

REVOKE ALL ON TABLE sales_booking_runner_journal FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE sales_booking_runner_journal TO service_role;
GRANT ALL ON TABLE sales_booking_runner_journal TO marninstobbe;
