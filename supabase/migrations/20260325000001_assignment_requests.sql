-- Assignment requests: lead installers request help from other trades
CREATE TABLE IF NOT EXISTS assignment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid DEFAULT '00000000-0000-0000-0000-000000000001',
  job_id uuid REFERENCES jobs(id),
  requested_by uuid REFERENCES users(id),
  requested_trade uuid REFERENCES users(id),
  requested_dates date[] NOT NULL,
  note text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decline_reason text,
  approved_by uuid,
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_assignment_requests_status ON assignment_requests(status);
CREATE INDEX IF NOT EXISTS idx_assignment_requests_job ON assignment_requests(job_id);
