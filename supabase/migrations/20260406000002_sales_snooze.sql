-- Sales snooze table: track snoozed action items in the sales dashboard
-- Salespeople can snooze a job for X days to remove it from the action queue temporarily

CREATE TABLE IF NOT EXISTS sales_snooze (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  snoozed_by uuid REFERENCES users(id),
  snoozed_until timestamptz NOT NULL,
  reason text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_sales_snooze_job ON sales_snooze(job_id);
CREATE INDEX idx_sales_snooze_until ON sales_snooze(snoozed_until DESC);

-- RLS: service role only (edge functions handle auth)
ALTER TABLE sales_snooze ENABLE ROW LEVEL SECURITY;
