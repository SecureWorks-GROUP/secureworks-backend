-- Chat logs for ops-ai interactions
-- Captures queries, responses, tools used, and job references for analytics/audit

CREATE TABLE IF NOT EXISTS chat_logs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid,
  user_email          text,
  role                text NOT NULL,
  query               text NOT NULL,
  response            text,
  tools_used          jsonb DEFAULT '[]',
  job_ids_referenced  uuid[] DEFAULT '{}',
  insights_generated  text[] DEFAULT '{}',
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_logs_role ON chat_logs(role);
CREATE INDEX IF NOT EXISTS idx_chat_logs_created ON chat_logs(created_at DESC);
